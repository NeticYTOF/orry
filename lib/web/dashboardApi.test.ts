process.env.ORRY_DB_PATH = ":memory:";

interface TestRow {
  createdAt?: number;
  updatedAt?: number;
  firstResponseAt?: number;
  firstHumanResponseAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
  requesterId?: string;
  question?: string;
  summary?: string;
  status?: string;
  assigneeId?: string;
  category?: string;
  [key: string]: unknown;
}
interface VolumeRow {
  questions: number;
}

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const programs = require("../programs");
const dash = require("./dashboardApi");

before(() => {
  db.close();
  db.open(":memory:");
});

function seedProgram(id: string, sources: TestRow[] | null = null) {
  programs.saveProgram({ id, name: id, sources, sharedSources: false });
}

function seedTicket(programId: string, overrides: TestRow = {}) {
  const t = overrides.createdAt !== undefined ? overrides.createdAt : Date.now();
  const res = db
    .handle()
    .query(
      `INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, summary, status, assignee_id, category,
      created_at, updated_at, first_response_at, first_human_response_at, resolved_at, resolved_by)
     VALUES (?, 'C', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      programId,
      `${programId}-${t}-${Math.random()}`,
      overrides.requesterId || "U-asker",
      overrides.question || "how do i join?",
      overrides.summary || null,
      overrides.status || "open",
      overrides.assigneeId || null,
      overrides.category || "support",
      t,
      overrides.updatedAt !== undefined ? overrides.updatedAt : t,
      overrides.firstResponseAt || null,
      overrides.firstHumanResponseAt || null,
      overrides.resolvedAt || null,
      overrides.resolvedBy || null,
    );
  return { id: Number(res.lastInsertRowid), createdAt: t };
}

test("scoped search refuses unknown programs and isolates tenants", () => {
  seedProgram("dash-tenant-a");
  seedProgram("dash-tenant-b");
  seedTicket("dash-tenant-b", { question: "other program secret" });
  assert.equal(dash.ticketSearchScoped("no-such-program", {}).error, "unknown program");
  const res = dash.ticketSearchScoped("dash-tenant-a", {});
  assert.equal(res.total, 0);
  assert.deepEqual(res.rows, []);
});

test("scoped search filters by status group, category, assignee and text", () => {
  seedProgram("dash-filter");
  const base = Date.now() - 50000;
  seedTicket("dash-filter", { status: "open", category: "pcb", createdAt: base });
  seedTicket("dash-filter", {
    status: "waiting_for_helper",
    category: "pcb",
    assigneeId: "U-1",
    createdAt: base + 1000,
  });
  seedTicket("dash-filter", { status: "resolved", category: "pcb", createdAt: base + 2000 });
  seedTicket("dash-filter", {
    status: "open",
    category: "ordering",
    question: "where is my package",
    createdAt: base + 3000,
  });

  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "open" }).total, 3);
  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "resolved" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "all" }).total, 4);
  assert.equal(dash.ticketSearchScoped("dash-filter", { status: "open" }).total, 2);
  assert.equal(dash.ticketSearchScoped("dash-filter", { category: "ordering" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { assigneeId: "U-1" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { q: "package" }).total, 1);
});

test("scoped search sorts longest-waiting first and paginates", () => {
  seedProgram("dash-sort");
  const base = Date.now() - 90000;
  const first = seedTicket("dash-sort", { createdAt: base });
  seedTicket("dash-sort", { createdAt: base + 1000 });
  seedTicket("dash-sort", { createdAt: base + 2000 });
  const waiting = dash.ticketSearchScoped("dash-sort", { sort: "waiting" });
  assert.equal(waiting.rows[0].id, first.id);
  const newest = dash.ticketSearchScoped("dash-sort", { sort: "created", limit: 1 });
  assert.equal(newest.rows.length, 1);
  assert.equal(newest.total, 3);
  const page2 = dash.ticketSearchScoped("dash-sort", { sort: "created", limit: 2, offset: 2 });
  assert.equal(page2.rows.length, 1);
});

test("scoped search attributes the first responder and counts notes", () => {
  seedProgram("dash-attr");
  const { id } = seedTicket("dash-attr", { status: "assigned", assigneeId: "U-helper" });
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'dash-attr', 'U-second', 'helper_reply', ?)",
    )
    .run(id, Date.now());
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'dash-attr', 'U-first', 'helper_reply', ?)",
    )
    .run(id, Date.now() - 5000);
  db.handle()
    .query(
      "INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, 'dash-attr', 'U-helper', 'context', ?)",
    )
    .run(id, Date.now());
  const res = dash.ticketSearchScoped("dash-attr", {});
  assert.equal(res.rows[0].first_responder_id, "U-first");
  assert.equal(res.rows[0].notes_count, 1);
});

test("scoped detail returns the thread and 404s cross-program", () => {
  seedProgram("dash-detail-a");
  seedProgram("dash-detail-b");
  const { id } = seedTicket("dash-detail-a", {});
  const hit = dash.ticketDetailScoped("dash-detail-a", id);
  assert.ok(hit.ticket);
  assert.ok(Array.isArray(hit.events));
  assert.ok(Array.isArray(hit.notes));
  assert.equal(dash.ticketDetailScoped("dash-detail-b", id).error, "ticket not found");
  assert.equal(dash.ticketDetailScoped("dash-detail-a", 999999).error, "ticket not found");
  assert.equal(dash.ticketDetailScoped("no-such-program", id).error, "unknown program");
});

test("metrics overview counts ops figures from stored rows only", () => {
  seedProgram("dash-metrics");
  const base = Date.now() - 20 * 86400000;
  seedTicket("dash-metrics", {
    status: "resolved",
    createdAt: base,
    firstResponseAt: base + 1000,
    resolvedAt: base + 5000,
  });
  seedTicket("dash-metrics", {
    status: "resolved",
    createdAt: base + 1000,
    firstResponseAt: base + 2000,
    firstHumanResponseAt: base + 3000,
    resolvedAt: base + 10000,
    resolvedBy: "U-H",
    assigneeId: "U-H",
  });
  seedTicket("dash-metrics", { status: "waiting_for_helper", createdAt: base + 2000, assigneeId: "U-H" });
  db.recordMetric("answer_docs", 10, null, "dash-metrics");
  db.recordMetric("silent", 5, "ungrounded", "dash-metrics");
  db.recordMetric("jev_downstream_block", 7, "gap_escalated", "dash-metrics");
  seedProgram("dash-metrics-other");
  seedTicket("dash-metrics-other", { status: "open", createdAt: base });
  db.recordMetric("silent", 5, "ungrounded", "dash-metrics-other");

  const m = dash.metricsOverview("dash-metrics", { days: 30 });
  assert.equal(m.created, 3);
  assert.equal(m.openTickets, 1);
  assert.equal(m.waitingForHelper, 1);
  assert.equal(m.firstResponse.medianMs, 1000);
  assert.equal(m.firstResponse.averageMs, 1000);
  assert.equal(m.firstResponse.n, 2);
  assert.equal(m.resolution.medianMs, 9000);
  assert.equal(m.resolution.averageMs, 7000);
  assert.equal(m.resolution.n, 2);
  assert.equal(m.answers.orryAnswered, 1);
  assert.equal(m.answers.humanHandled, 1);
  assert.equal(m.grounding.blocked, 2);
  assert.equal(m.grounding.byReason.ungrounded, 1);
  assert.equal(m.grounding.byReason["jev_downstream_block:gap_escalated"], 1);
  assert.equal(m.grounding.answered, 1);
  assert.equal(m.grounding.blockRate, 0.667);
  assert.ok(Array.isArray(m.volumeByDay) && m.volumeByDay.length >= 30);
  assert.equal(
    m.volumeByDay.reduce((sum: number, d: VolumeRow) => sum + d.questions, 0),
    3,
  );
  const helper = m.helpers.find((h: TestRow) => h.userId === "U-H");
  assert.equal(helper.openAssigned, 1);
  assert.equal(helper.resolved, 1);
  assert.equal(dash.metricsOverview("no-such-program", {}).error, "unknown program");
});

test("knowledge status degrades gracefully and never leaks secrets", () => {
  const knowledge = require("../knowledge");
  const realStatus = knowledge.sourceStatus;
  const realRefresh = knowledge.refreshProgramSources;
  delete knowledge.sourceStatus;
  delete knowledge.refreshProgramSources;
  try {
    seedProgram("dash-know", [{ name: "Docs", type: "url", url: "https://docs.example/guide?token=secret#frag" }]);
    const res = dash.knowledgeStatus("dash-know");
    assert.equal(res.programId, "dash-know");
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].status, "Pending");
    assert.equal(res.sources[0].url, "https://docs.example/guide");
    assert.equal(JSON.stringify(res).includes("token=secret"), false);
    assert.equal(dash.knowledgeStatus("no-such-program").error, "unknown program");
    assert.equal(dash.knowledgeRefresh("no-such-program").error, "unknown program");
    assert.equal(dash.knowledgeRefresh("dash-know").error, "knowledge refresh is not available");
  } finally {
    knowledge.sourceStatus = realStatus;
    knowledge.refreshProgramSources = realRefresh;
  }
});

test("real knowledge status values render as dashboard labels", () => {
  seedProgram("dash-know-real", [{ name: "Inline", type: "text", content: "Acme FAQ text" }]);
  const res = dash.knowledgeStatus("dash-know-real");
  assert.equal(res.sources.length, 1);
  assert.ok(["Pending", "Ready", "Stale", "Error", "Fetching"].includes(res.sources[0].status));
});

test("knowledge status and refresh honor the sourceStatus contract when present", async () => {
  const knowledge = require("../knowledge");
  seedProgram("dash-know-live");
  knowledge.sourceStatus = () => [
    {
      name: "Docs",
      type: "url",
      url: "https://docs.example/a?x=1",
      status: "Ready",
      lastSyncedAt: 100,
      lastSuccessAt: 90,
      error: null,
      chunks: 12,
    },
    { name: "Bad", type: "url", url: "not a url", status: "Exploding", lastSyncedAt: "n/a", error: "boom", chunks: -1 },
  ];
  let calledWith = null;
  knowledge.refreshProgramSources = ((programId: string, opts: TestRow) => {
    calledWith = [programId, opts];
    return Promise.resolve({ ok: true });
  }) as unknown as typeof knowledge.refreshProgramSources;
  try {
    const res = dash.knowledgeStatus("dash-know-live");
    assert.equal(res.sources[0].status, "Ready");
    assert.equal(res.sources[0].chunks, 12);
    assert.equal(res.sources[0].url, "https://docs.example/a");
    assert.equal(res.sources[1].status, "Pending");
    assert.equal(res.sources[1].chunks, null);
    const refresh = dash.knowledgeRefresh("dash-know-live");
    assert.deepEqual(refresh, { started: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calledWith, ["dash-know-live", { force: true }]);
  } finally {
    delete knowledge.sourceStatus;
    delete knowledge.refreshProgramSources;
  }
});

test("helper roster and availability toggle are program-scoped", () => {
  seedProgram("dash-roster");
  seedProgram("dash-roster-other");
  db.syncHelper({ programId: "dash-roster", userId: "U-R1", role: "helper" });
  db.syncHelper({ programId: "dash-roster", userId: "U-R2", role: "organizer" });
  db.syncHelper({ programId: "dash-roster-other", userId: "U-X", role: "helper" });
  const { id: tid } = seedTicket("dash-roster", {
    status: "assigned",
    assigneeId: "U-R1",
    createdAt: Date.now() - 1000,
  });
  void tid;

  const roster = dash.helperRoster("dash-roster");
  assert.equal(roster.programId, "dash-roster");
  assert.equal(roster.helpers.length, 2);
  assert.ok(roster.helpers.every((h: TestRow) => h.active));
  assert.equal(roster.helpers.find((h: TestRow) => h.userId === "U-R2").role, "organizer");
  assert.equal(roster.helpers.find((h: TestRow) => h.userId === "U-R1").openAssigned, 1);
  assert.equal(dash.helperRoster("no-such-program").error, "unknown program");

  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-stranger", userId: "U-R1", active: false }).error,
    "actor is not a helper of this program",
  );
  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-X", userId: "U-R1", active: false }).error,
    "actor is not a helper of this program",
  );
  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-ghost", active: false }).error,
    "helper not found",
  );

  assert.equal(dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-R1", active: false }).ok, true);
  assert.equal(dash.helperRoster("dash-roster").helpers.find((h: TestRow) => h.userId === "U-R1").active, false);
  assert.equal(dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-R1", active: true }).ok, true);
  assert.equal(dash.helperRoster("dash-roster").helpers.find((h: TestRow) => h.userId === "U-R1").active, true);
});

test("access answers admin and active-helper flags for one program only", () => {
  seedProgram("dash-access-a");
  seedProgram("dash-access-b");
  db.syncHelper({ programId: "dash-access-a", userId: "U-acc-helper" });
  db.syncHelper({ programId: "dash-access-a", userId: "U-acc-gone" });
  db.removeHelper({ programId: "dash-access-a", userId: "U-acc-gone" });
  const { config } = require("../config");
  config.slack.adminUserIds.push("U-acc-admin");
  try {
    assert.deepEqual(dash.userAccess("dash-access-a", "U-acc-helper"), {
      programId: "dash-access-a",
      userId: "U-acc-helper",
      admin: false,
      helper: true,
    });
    assert.equal(dash.userAccess("dash-access-b", "U-acc-helper").helper, false, "helper of A is not a helper of B");
    assert.equal(dash.userAccess("dash-access-a", "U-acc-gone").helper, false, "a removed helper loses access");
    const admin = dash.userAccess("dash-access-b", "U-acc-admin");
    assert.equal(admin.admin, true);
    assert.equal(admin.helper, false);
    assert.equal(dash.userAccess("dash-access-a", "").error, "userId required");
    assert.equal(dash.userAccess("dash-access-a", "U x' OR 1=1").error, "userId required");
    assert.equal(dash.userAccess("dash-access-missing", "U-acc-helper").error, "unknown program");
  } finally {
    config.slack.adminUserIds.splice(config.slack.adminUserIds.indexOf("U-acc-admin"), 1);
  }
});

function seedEvent(
  ticketId: number,
  programId: string,
  eventType: string,
  actorId: string | null,
  detail: unknown,
  at: number,
) {
  return db.addTicketEvent({ ticketId, programId, actorId, eventType, detail, createdAt: at });
}

test("closing route labels the latest close, hides requester ids and text, and pairs pings with claims", () => {
  const P = "dash-closing";
  seedProgram(P);
  seedProgram("dash-closing-other");
  db.syncHelper({ programId: P, userId: "U-cl-helper" });
  const t0 = Date.UTC(2026, 9, 5, 12, 0, 0);
  const H = 3600000;
  const helperClosed = seedTicket(P, {
    status: "resolved",
    createdAt: t0,
    resolvedAt: t0 + 2 * H,
    requesterId: "U-cl-kid",
    question: "SENTINEL-QUESTION-TEXT",
  });
  seedEvent(helperClosed.id, P, "escalated", null, { by: "ai_no_answer" }, t0 + 60000);
  seedEvent(helperClosed.id, P, "helper_assignment_offered", null, { to: "U-cl-helper", source: "ping" }, t0 + 120000);
  seedEvent(helperClosed.id, P, "helper_assignment_claimed", "U-cl-helper", { source: "targeted" }, t0 + 300000);
  seedEvent(helperClosed.id, P, "claimed", "U-cl-helper", null, t0 + 300000);
  seedEvent(helperClosed.id, P, "resolved", "U-cl-helper", { source: "macro" }, t0 + 2 * H);

  // Closed by Orry once, reopened, then closed by the participant: the newest write wins
  // even though the auto-resolve was backdated past it.
  const selfClosed = seedTicket(P, {
    status: "resolved",
    createdAt: t0,
    resolvedAt: t0 + 5 * H,
    requesterId: "U-cl-kid",
  });
  seedEvent(selfClosed.id, P, "resolved", "U-cl-kid", null, t0 + 5 * H);
  seedEvent(
    selfClosed.id,
    P,
    "resolved",
    null,
    { source: "auto", verdict: "resolved", confidence: 0.91, reason: "SENTINEL-JUDGE-REASON" },
    t0 + 6 * H,
  );
  db.handle()
    .query("UPDATE ticket_events SET id = id + 1000 WHERE ticket_id = ? AND actor_id = 'U-cl-kid'")
    .run(selfClosed.id);

  const imported = seedTicket(P, { status: "closed", createdAt: t0, resolvedAt: t0 + 3 * H });
  db.handle().query("UPDATE tickets SET visibility = 'dashboard' WHERE id = ?").run(imported.id);
  seedEvent(imported.id, P, "closed", null, { source: "backfill", reason: "no answer (history import)" }, t0 + 3 * H);
  seedEvent(imported.id, P, "helper_assignment_offered", null, { to: "U-cl-helper", source: "ping" }, t0 + H);
  seedEvent(imported.id, P, "helper_assignment_timed_out", null, { to: "U-cl-helper" }, t0 + 2 * H);

  const macroClosed = seedTicket(P, { status: "closed", createdAt: t0, resolvedAt: t0 + 4 * H });
  seedTicket(P, { status: "open", createdAt: t0 });
  seedTicket(P, { status: "resolved", createdAt: t0, resolvedAt: t0 + 30 * 86400000 });
  seedTicket("dash-closing-other", { status: "resolved", createdAt: t0, resolvedAt: t0 + H });

  const res = dash.ticketClosing(P, { since: t0, until: t0 + 7 * 86400000 });
  assert.equal(res.total, 4, "only finished tickets inside the window, in this program");
  assert.deepEqual(
    res.rows.map((r: TestRow) => r.id),
    [helperClosed.id, imported.id, macroClosed.id, selfClosed.id],
    "ordered by resolved_at",
  );
  const byId = new Map<unknown, any>(res.rows.map((r: TestRow) => [r.id, r]));
  const helperRow = byId.get(helperClosed.id);
  assert.equal(helperRow.closing.actorKind, "helper");
  assert.equal(helperRow.closing.actorId, "U-cl-helper");
  assert.equal(helperRow.firstEscalatedAt, t0 + 60000);
  assert.deepEqual(helperRow.firstTaken, { at: t0 + 300000, event: "claimed", by: "U-cl-helper", automatic: false });
  assert.equal(helperRow.pings.length, 1);
  assert.equal(helperRow.pings[0].claimFollowed, true);

  const selfRow = byId.get(selfClosed.id);
  assert.equal(selfRow.closing.actorKind, "requester");
  assert.equal(selfRow.closing.actorId, null, "the participant's id is never returned");

  const importRow = byId.get(imported.id);
  assert.equal(importRow.closing.source, "backfill");
  assert.equal(importRow.closing.actorKind, "orry");
  assert.equal(importRow.visibility, "dashboard");
  assert.equal(importRow.pings[0].outcome, "timed_out");
  assert.equal(importRow.pings[0].claimFollowed, false);

  assert.equal(byId.get(macroClosed.id).closing, null, "a macro close writes no event");

  const blob = JSON.stringify(res);
  assert.equal(blob.includes("SENTINEL"), false, "no ticket text or judge reason");
  assert.equal(blob.includes("U-cl-kid"), false, "no requester id");
  assert.equal(blob.includes("U-asker"), false);

  const paged = dash.ticketClosing(P, { since: t0, until: t0 + 7 * 86400000, limit: 2, offset: 2 });
  assert.equal(paged.total, 4);
  assert.deepEqual(
    paged.rows.map((r: TestRow) => r.id),
    [macroClosed.id, selfClosed.id],
  );
  assert.match(dash.ticketClosing(P, { since: t0, until: t0 }).error, /before/);
  assert.equal(dash.ticketClosing("dash-closing-missing", {}).error, "unknown program");
});

test("ticket detail returns the newest events of a long ticket and pages older ones", () => {
  seedProgram("dash-long");
  const { id, createdAt } = seedTicket("dash-long", { status: "resolved" });
  for (let i = 0; i < 130; i += 1) seedEvent(id, "dash-long", "helper_reply", "U-long", { n: i }, createdAt + i * 1000);
  seedEvent(id, "dash-long", "resolved", "U-long", null, createdAt + 200000);
  const first = dash.ticketDetailScoped("dash-long", id);
  assert.equal(first.events.length, 100);
  assert.equal(first.eventsTotal, 131);
  assert.equal(first.eventsHasOlder, true);
  assert.equal(first.events[first.events.length - 1].event_type, "resolved", "the latest close is on the first page");
  assert.ok(first.events[0].created_at < first.events[99].created_at, "oldest-first within the page");
  const older = dash.ticketDetailScoped("dash-long", id, { eventsOffset: 100 });
  assert.equal(older.events.length, 31);
  assert.equal(older.eventsHasOlder, false);
  assert.equal(JSON.parse(older.events[0].detail).n, 0);
  assert.equal(dash.ticketDetailScoped("dash-long", id, { eventsLimit: 9999 }).events.length, 131, "limit caps at 200");
});

test("scoped search takes several statuses, unassigned, visibility and assigned-at filters", () => {
  const P = "dash-g11";
  seedProgram(P);
  const released = seedTicket(P, { status: "open" });
  db.handle().query("UPDATE tickets SET assigned_at = 1 WHERE id = ?").run(released.id);
  const fresh = seedTicket(P, { status: "open" });
  const owned = seedTicket(P, { status: "claimed", assigneeId: "U-g11" });
  const reopened = seedTicket(P, { status: "reopened", assigneeId: "U-g11" });
  const imported = seedTicket(P, { status: "waiting_for_helper" });
  db.handle().query("UPDATE tickets SET visibility = 'dashboard' WHERE id = ?").run(imported.id);
  seedTicket(P, { status: "resolved" });
  const ids = (params: TestRow) =>
    dash
      .ticketSearchScoped(P, params)
      .rows.map((r: TestRow) => r.id)
      .sort((a: number, b: number) => a - b);

  assert.deepEqual(ids({ status: "claimed,reopened" }), [owned.id, reopened.id]);
  assert.deepEqual(ids({ status: "claimed, reopened,claimed" }), [owned.id, reopened.id], "trimmed and deduped");
  assert.deepEqual(ids({ statusGroup: "open", unassigned: "1" }), [released.id, fresh.id, imported.id]);
  assert.deepEqual(ids({ status: "open", hasAssignedAt: "true" }), [released.id], "released tickets keep assigned_at");
  assert.deepEqual(ids({ visibility: "dashboard" }), [imported.id]);
  assert.deepEqual(ids({ status: "open", unassigned: "0" }), [released.id, fresh.id], "0 does not filter");
});

export {};
