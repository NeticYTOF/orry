/* One test per known trap (PLAN 9.1): window-scoped open, first_response_at, backdated auto-resolves, import tickets,
   credit to requesters, reopen without reply, release back to open, resolve then reopen, equal-timestamp paging ties,
   a ticket at the exact Monday boundary. Small invented fixtures only. */
import { describe, expect, it } from "vitest";
import { headline, hasNoOwner, humanReplySince, limitChip, needsHuman, previousOwner, viewsOf, waitingSince, type BoardContext } from "../lib/metrics/board";
import { createdIn, finishedIn, weekStats, withinLimit, personMeasures, type StatsContext } from "../lib/metrics/week";
import { creditedHelper, rowLabel } from "../lib/metrics/finishedBy";
import { parseWeek, weekKey } from "../lib/metrics/time";
import { pageByCreated, pageByUpdated, reopenFromEvents } from "../lib/data/reads";
import { coreSearch } from "../lib/data/fixtures/source";
import { ADMIN, DAY, event, HELPER, HELPER2, HOUR, MemorySource, meta, MIN, REQ, ROSTER, row, T0 } from "../lib/data/testing";

const W42 = parseWeek("2026-W42")!;
const W43 = parseWeek("2026-W43")!;
const now = T0 + 6 * DAY + 14 * HOUR;                     // Sunday of week 42, 14:00 UTC
const board = (o: Partial<BoardContext> = {}): BoardContext => ({ now, limitMs: 120 * MIN, me: HELPER, ...o });
const stats = (o: Partial<StatsContext> = {}): StatsContext => ({ now, limitMs: 120 * MIN, roster: ROSTER, includeImported: false, ...o });

describe("trap 1: window-scoped open", () => {
  it("counts an open ticket created long before any window, and uses no creation window", () => {
    const old = row({ id: 1, status: "waiting_for_helper", created_at: now - 40 * DAY });
    const fresh = row({ id: 2, status: "waiting_for_helper", created_at: now - 30 * MIN });
    const h = headline([old, fresh], board());
    expect(h.needHuman).toBe(2);
    expect(h.oldest?.id).toBe(1);
    expect(h.over48h).toBe(1);
    expect(viewsOf(old, board())).toContain("48h");
  });
});

describe("trap 2: first_response_at is not a human reply", () => {
  it("ignores Orry's status-message stamp for the board and for first human reply", () => {
    const t = row({ id: 3, status: "waiting_for_helper", created_at: now - 3 * HOUR, first_response_at: now - 3 * HOUR + 30_000 });
    expect(humanReplySince(t, board())).toBe(false);
    expect(limitChip(t, board())).toBe("over");
    const m = meta({ id: 3, status: "resolved", created_at: W42.start + HOUR, resolved_at: W42.start + 5 * HOUR, first_response_at: W42.start + HOUR + 30_000, resolution: "resolved by <@U0TESTH01>", resolved_by: HELPER });
    const s = weekStats([m], [m], [m], stats());
    expect(s.firstReply.n).toBe(0);
    expect(s.firstReply.withNone).toBe(1);
    expect(s.noHumanReply.n).toBe(1);
  });
});

describe("trap 3: backdated auto-resolves", () => {
  it("counts a last-word resolve written in week 43 in week 42, and paging by updated_at still finds it", async () => {
    const t = row({
      id: 4, status: "resolved", created_at: W42.start + 2 * DAY, resolved_at: W42.start + 5 * DAY, updated_at: W43.start + DAY,
      resolution: "resolved: a helper had the last word and the requester didn't come back", resolved_by: HELPER, resolved_credit_id: HELPER
    });
    const later = row({ id: 5, status: "resolved", created_at: W43.start, resolved_at: W43.start + 2 * HOUR, updated_at: W43.start + 2 * HOUR, resolution: "resolved by <@U0TESTH01>", resolved_by: HELPER });
    expect(rowLabel(t)).toBe("orry_last_word");
    const ds = new MemorySource([t, later], { now: W43.start + 2 * DAY });
    const paged = await pageByUpdated(ds, { statusGroup: "resolved" }, W42.start);
    expect(paged.rows.map(r => r.id).sort()).toEqual([4, 5]);
    const fin = finishedIn(paged.rows.map(r => meta(r)), W42, stats());
    expect(fin.map(r => r.id)).toEqual([4]);
    const s = weekStats([], fin, [], stats());
    expect(s.orry.lastWord).toBe(1);
    expect(s.credited.size).toBe(0); // Orry's closes count for nobody, even with a credited helper on the row
  });
});

describe("trap 4: import tickets", () => {
  it("leaves dashboard-visible tickets out of every number unless imports are included", () => {
    const live = meta({ id: 6, status: "resolved", created_at: W42.start + HOUR, resolved_at: W42.start + 3 * HOUR, resolution: "resolved by <@U0TESTH01>", resolved_by: HELPER, resolved_credit_id: HELPER });
    const imp = meta({ id: 7, status: "resolved", visibility: "dashboard", created_at: W42.start + HOUR, resolved_at: W42.start + 2 * HOUR, resolution: "resolved from historical confirmation" });
    expect(createdIn([live, imp], W42, stats()).map(t => t.id)).toEqual([6]);
    expect(finishedIn([live, imp], W42, stats()).map(t => t.id)).toEqual([6]);
    expect(finishedIn([live, imp], W42, stats({ includeImported: true })).map(t => t.id)).toEqual([6, 7]);
    expect(rowLabel({ ...imp, resolution: "resolved from historical confirmation" })).toBe("import_resolved");
    const s = weekStats([live], [live], [live, imp], stats());
    expect(s.createdImported).toBe(1);
    // on the board: imported rows only in "Imported" and "All open"
    const openImp = row({ id: 8, status: "open", visibility: "dashboard", created_at: now - 9 * DAY });
    expect(viewsOf(openImp, board())).toEqual(["all", "imp"]);
    expect(headline([openImp], board()).needHuman).toBe(0);
    // a dashboard-only program: nothing counts as imported
    expect(viewsOf(openImp, board({ importDetection: false }))).toContain("orry");
  });
  it("labels a history-import close with no answer apart from a hand close", () => {
    expect(rowLabel({ status: "closed", resolution: "no answer (history import)", resolved_by: null, requester_id: REQ })).toBe("import_closed");
    expect(rowLabel({ status: "closed", resolution: null, resolved_by: null, requester_id: REQ })).toBe("person_or_macro");
  });
});

describe("trap 5: credit to requesters", () => {
  it("never credits a participant's own close to the helper the bot wrote as worker", () => {
    const selfRow = row({ id: 9, status: "resolved", created_at: W42.start, resolved_at: W42.start + HOUR, resolution: `resolved by <@${REQ}>`, resolved_by: REQ, resolved_credit_id: HELPER, first_human_response_at: W42.start + 10 * MIN, first_responder_id: HELPER });
    const self = meta(selfRow);
    expect(rowLabel(selfRow)).toBe("participant");
    expect(self.rowLabel).toBe("participant");
    expect(creditedHelper(self, "participant", ROSTER)).toBeNull();
    expect(personMeasures(HELPER, [self], [self], stats()).finished).toBe(0);
    expect(personMeasures(HELPER, [self], [self], stats()).firstReplies).toBe(1);
  });
  it("gives no credit when the only credit candidates are not on the roster", () => {
    const t = meta({ id: 10, status: "resolved", created_at: W42.start, resolved_at: W42.start + HOUR, resolution: "resolved by <@U0SOMEONE>", resolved_by: "U0SOMEONE", resolved_credit_id: REQ });
    expect(t.rowLabel).toBe("helper");
    expect(creditedHelper(t, "helper", ROSTER)).toBeNull();
    const ok = meta({ id: 11, status: "resolved", created_at: W42.start, resolved_at: W42.start + HOUR, resolution: "resolved", resolved_by: "U0SOMEONE", resolved_credit_id: REQ, assignee_id: HELPER2 });
    expect(creditedHelper(ok, "helper", ROSTER)).toBe(HELPER2); // credit_id, then assignee_id, then resolved_by, roster only
  });
});

describe("trap 6: reopen without reply", () => {
  const reopened = row({ id: 12, status: "reopened", created_at: now - 3 * DAY, reopened_at: now - 150 * MIN, assignee_id: HELPER2, first_human_response_at: now - 3 * DAY + 20 * MIN, reopen_count: 1 });
  it("is over the limit and has no owner when nothing happened after the reopen", () => {
    const d = { ticket: reopened, events: [event({ ticket_id: 12, event_type: "helper_reply", actor_id: HELPER2, created_at: now - 3 * DAY + 20 * MIN }), event({ ticket_id: 12, event_type: "reopened", actor_id: REQ, created_at: now - 150 * MIN })], notes: [], eventsTruncated: false };
    const ctx = board({ reopen: new Map([[12, reopenFromEvents(d, reopened.reopened_at!, ROSTER)]]) });
    expect(waitingSince(reopened).at).toBe(reopened.reopened_at); // the old first reply does not count
    expect(humanReplySince(reopened, ctx)).toBe(false);
    expect(limitChip(reopened, ctx)).toBe("over");
    expect(hasNoOwner(reopened, ctx)).toBe(true);
    expect(previousOwner(reopened, ctx)).toBe(HELPER2);
    expect(viewsOf({ ...reopened, assignee_id: HELPER }, ctx)).not.toContain("mine");
  });
  it("counts a reply by a roster helper after the reopen, and says unknown when 100 events came back", () => {
    const d = { ticket: reopened, events: [event({ ticket_id: 12, event_type: "helper_reply", actor_id: HELPER, created_at: now - 100 * MIN })], notes: [], eventsTruncated: false };
    const ctx = board({ reopen: new Map([[12, reopenFromEvents(d, reopened.reopened_at!, ROSTER)]]) });
    expect(humanReplySince(reopened, ctx)).toBe(true);
    expect(limitChip(reopened, ctx)).toBeNull();
    const truncated = board({ reopen: new Map([[12, reopenFromEvents({ ...d, events: [], eventsTruncated: true }, reopened.reopened_at!, ROSTER)]]) });
    expect(limitChip(reopened, truncated)).toBe("unknown");
    expect(headline([reopened], truncated).unknown).toBe(1);
    // G29: last_human_reply_at after the reopen decides without events
    expect(humanReplySince({ ...reopened, last_human_reply_at: now - 10 * MIN }, board())).toBe(true);
  });
});

describe("trap 7: release back to open", () => {
  it("keeps a released ticket in Needs a human, with no owner and an 'at least' wait from updated_at", () => {
    const t = row({ id: 13, status: "open", assignee_id: null, assigned_at: now - 6 * HOUR, created_at: now - 7 * HOUR, updated_at: now - 5 * HOUR });
    expect(needsHuman(t)).toBe(true);
    expect(waitingSince(t)).toEqual({ at: now - 5 * HOUR, atLeast: true });
    expect(viewsOf(t, board())).toEqual(expect.arrayContaining(["human", "noowner"]));
    expect(viewsOf(t, board())).not.toContain("orry");
    const h = headline([t], board());
    expect(h).toMatchObject({ needHuman: 1, noOwner: 1, over: 1, oldest: { id: 13, atLeast: true } });
    // plain status open without assigned_at is not counted (answered by Orry, or never confirmed)
    expect(needsHuman(row({ id: 14, status: "open" }))).toBe(false);
  });
});

describe("trap 8: resolve then reopen (the old owner)", () => {
  it("drops the ticket from finished, shows the previous owner, and counts the reopen in the created group", () => {
    const t = meta({ id: 15, status: "reopened", created_at: W42.start + DAY, resolved_at: null, resolution: null, resolved_by: null, reopened_at: W42.start + 3 * DAY, reopen_count: 1, assignee_id: HELPER, first_human_response_at: W42.start + DAY + 30 * MIN, first_responder_id: HELPER });
    expect(t.rowLabel).toBeNull();
    expect(finishedIn([t], W42, stats())).toHaveLength(0);
    const s = weekStats([t], [], [t], stats());
    expect(s.reopened).toMatchObject({ n: 1, of: 1 });
    expect(personMeasures(HELPER, [t], [], stats()).reopened).toBe(1);
    const ctx = board({ now: W42.start + 4 * DAY, reopen: new Map([[15, { humanSince: false, ownerSince: false }]]) });
    expect(previousOwner(row({ ...t, question: "x" }), ctx)).toBe(HELPER);
    // an assign after the reopen makes the owner count again
    const assigned = { ...row({ ...t, question: "x" }), status: "assigned" as const };
    expect(hasNoOwner(assigned, board({ reopen: new Map([[15, { humanSince: true, ownerSince: true }]]) }))).toBe(false);
  });
});

describe("trap 9: equal-timestamp ties in paging", () => {
  it("recovers rows that one ORDER BY column without a tie-break skips at page boundaries", async () => {
    // 450 open tickets; 30 of them share created_at around the first page boundary (rows 190-219)
    const rows = Array.from({ length: 450 }, (_, i) => row({ id: 1000 + i, status: "waiting_for_helper", created_at: i >= 190 && i < 220 ? T0 + 190 * MIN : T0 + i * MIN }));
    const ds = new MemorySource(rows, { shuffleTies: true });
    // a naive pager loses rows
    const naive = new Set<number>();
    for (let off = 0; off < 450; off += 200) for (const r of (await ds.searchTickets({ statusGroup: "open", sort: "waiting", limit: 200, offset: off })).rows) naive.add(r.id);
    expect(naive.size).toBeLessThan(450);
    const p = await pageByCreated(ds, { statusGroup: "open", sort: "waiting" });
    expect(new Set(p.rows.map(r => r.id)).size).toBe(450);
    expect(p.complete).toBe(true);
  });
  it("repairs ties on updated_at with a second pass", async () => {
    const rows = Array.from({ length: 420 }, (_, i) => row({ id: 5000 + i, status: "resolved", resolution: "resolved", created_at: T0, resolved_at: T0 + DAY, updated_at: i >= 185 && i < 215 ? T0 + 2 * DAY : T0 + 3 * DAY - i * MIN }));
    const ds = new MemorySource(rows, { shuffleTies: true });
    const p = await pageByUpdated(ds, { statusGroup: "resolved" }, T0);
    expect(p.tieRepair).toBe(true);
    expect(new Set(p.rows.map(r => r.id)).size).toBe(420);
  });
});

describe("trap 10: a ticket at the exact Monday boundary", () => {
  it("lands in exactly one week, both in the metrics and in Core's since/until query", () => {
    const t = row({ id: 16, created_at: W43.start });            // Monday 19 Oct 2026, 00:00:00.000 UTC
    expect(weekKey(t.created_at)).toBe("2026-W43");
    expect(createdIn([meta(t)], W42, stats())).toHaveLength(0);
    expect(createdIn([meta(t)], W43, stats())).toHaveLength(1);
    // since is created_at >, until is created_at <=, so the site asks for (start - 1, end - 1]
    const q42 = coreSearch([t], { since: W42.start - 1, until: W42.end - 1 });
    const q43 = coreSearch([t], { since: W43.start - 1, until: W43.end - 1 });
    expect([q42.total, q43.total]).toEqual([0, 1]);
    // the naive window (start, end] puts it in week 42 instead
    expect(coreSearch([t], { since: W42.start, until: W42.end }).total).toBe(1);
  });
});

describe("within the limit (K27)", () => {
  it("leaves tickets younger than the limit with no reply out of the denominator", () => {
    const replied = meta({ id: 20, created_at: now - 10 * HOUR, first_human_response_at: now - 10 * HOUR + 30 * MIN, status: "claimed", assignee_id: HELPER });
    const late = meta({ id: 21, created_at: now - 10 * HOUR, first_human_response_at: now - 6 * HOUR, status: "claimed", assignee_id: HELPER });
    const waiting = meta({ id: 22, created_at: now - 5 * HOUR, status: "waiting_for_helper" });
    const young = meta({ id: 23, created_at: now - 30 * MIN, status: "waiting_for_helper" });
    const orryOnly = meta({ id: 24, created_at: now - 9 * HOUR, status: "open" });
    expect(withinLimit([replied, late, waiting, young, orryOnly], stats())).toEqual({ within: 1, of: 3, stillInside: 1, pct: 33 });
  });
});

void ADMIN;
