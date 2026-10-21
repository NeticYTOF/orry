/* The fixtures reproduce the mockups' week 42 through the real paging, metrics and view-models. */
import { beforeAll, describe, expect, it } from "vitest";
import { FixtureSource } from "../lib/data/fixtures/source";
import { generateFixtures } from "../lib/data/fixtures/generate";
import { clearAllCaches } from "../lib/data/cache";
import { getBoardModel } from "../lib/models/board";
import { getStatsModel } from "../lib/models/stats";
import { getClosedModel } from "../lib/models/closed";
import { getMeModel, getLeaderboardModel } from "../lib/models/people";
import { setLogEvent, setPreferencesStore, MemoryPreferences } from "../lib/models/deps";
import { DEFAULT_FIXTURE_NOW } from "../lib/data/clock";

const juno = { accountId: 1, slackId: "U0JUNO001", role: "helper" as const, handle: "pixel-otter", name: "Juno Baker" };
let ds: FixtureSource;
beforeAll(() => {
  clearAllCaches();
  setLogEvent(() => undefined);
  setPreferencesStore(new MemoryPreferences(["U0NOAH001"]));
  ds = new FixtureSource({ pendingAfterMs: null, state: "live" });
});

describe("the generator", () => {
  it("is deterministic and has about 550 invented tickets, no time after 'now'", () => {
    const a = generateFixtures(), b = generateFixtures();
    expect(JSON.stringify(a.tickets)).toBe(JSON.stringify(b.tickets));
    expect(a.tickets.length).toBeGreaterThan(500);
    const late = a.tickets.filter(t => [t.created_at, t.updated_at, t.resolved_at, t.first_human_response_at].some(v => v != null && v > a.now));
    expect(late).toHaveLength(0);
    expect(new Set(a.tickets.map(t => t.id)).size).toBe(a.tickets.length);
  });
  it("moves with ORRY_NOW and keeps its shape", () => {
    const shifted = generateFixtures({ now: DEFAULT_FIXTURE_NOW + 7 * 86_400_000 });
    expect(shifted.tickets.length).toBe(generateFixtures().tickets.length);
  });
});

describe("week 42 as in the mockups", () => {
  it("board: 7 need a human (5 + 2), 3 no owner, oldest at least 5 h 12 min #1042, 2 over the limit", async () => {
    const m = await getBoardModel(juno, {}, ds);
    expect(m.headline).toMatchObject({ needHuman: 7, waitingFirstReply: 5, inProgress: 2, noOwner: 3, over: 2, near: 1 });
    expect(m.headline.oldest).toMatchObject({ id: 1042, waitText: "5 h 12 min", atLeast: true });
    expect(m.views.find(v => v.key === "mine")!.count).toBe(1);
    expect(m.freshness.tag).toBe("LIVE · 14:02");
    const r1053 = m.rows.find(r => r.id === 1053)!;
    expect(r1053.question).toBeNull();
    expect(r1053.questionNote).toBe("Sensitive topic. Open the ticket to read it.");
    expect(m.rows.find(r => r.id === 1047)!.previousOwner?.name).toBe("Leila Haddad");
    expect(m.rows.find(r => r.id === 1042)!.releasedBy?.name).toBe("Mia Kowalski");
  });
  it("statistics: 47 finished = 41 + 6; Orry 17 = 9 + 4 + 4; people 30 = 19 + 7 + 4; 52 created", async () => {
    const s = await getStatsModel(juno, { week: "2026-W42" }, ds);
    expect(s.equation).toMatchObject({ resolved: 41, closed: 6, finished: 47 });
    expect(s.finishedBy.orry).toMatchObject({ total: 17, lastWord: 9, judge: 4, historyImport: 4 });
    expect(s.finishedBy.people).toMatchObject({ total: 30, helpers: 19, participants: 7, personOrMacro: 4 });
    const v = Object.fromEntries(s.strip.map(x => [x.key, x]));
    expect(v.created.value).toBe("52");
    expect(v.finished.compare).toBe("Down from 58");
    expect(v.orry.qualifier).toBe("36 % of 47");
    expect(v.orry.compare).toBe("Up from 34 %");
    expect(v.first_reply.value).toBe("38 min");
    expect(v.first_reply.compare).toBe("Faster than 52 min");
    expect(v.resolution.value).toBe("6 h 5 min");
    expect(v.reopened.qualifier).toBe("4 of 52");
    expect(s.counted.find(c => c.measure === "First human reply")!.p90).toBe("4 h 10 min");
    expect(s.counted.find(c => c.measure === "Time to resolution")!.p90).toBe("2 d 3 h");
    expect(s.categories.rows.map(c => [c.key, c.created])).toEqual([["review", 14], ["advice_how_to", 13], ["other", 11], ["site_bug", 7], ["fulfillment_shipping", 4], ["account_access", 3]]);
    expect(s.flowChart.weeks.map(w => w.created)).toEqual([31, 38, 44, 41, 36, 29, 47, 55, 49, 58, 61, 52]);
    expect(s.flowChart.weeks.map(w => w.finished)).toEqual([27, 34, 40, 45, 38, 31, 39, 50, 53, 51, 58, 47]);
    expect(s.heat.total).toBe(220);
    expect(s.team.totals).toMatchObject({ finished: 19, firstReplies: 41, median: "38 min", reopened: "4 of 41" });
    const inc = await getStatsModel(juno, { week: "2026-W42", includeImported: true }, ds);
    expect(inc.strip.find(x => x.key === "created")!.value).toBe("55");
  });
  it("closed tickets: 47 = 17 + 19 + 7 + 4, helpers 6, 4, 3, 3, 2, 1", async () => {
    const c = await getClosedModel(juno, { week: "2026-W42" }, ds);
    expect(c.counts).toEqual({ all: 47, orry: 17, helper: 19, participant: 7, person: 4 });
    const byPerson = new Map<string, number>();
    for (const r of c.rows) if (r.closedBy.kind === "helper") byPerson.set(r.closedBy.person.name!, (byPerson.get(r.closedBy.person.name!) ?? 0) + 1);
    expect([...byPerson.values()].sort((a, b) => b - a)).toEqual([6, 4, 3, 3, 2, 1]);
    expect(c.rows.some(r => r.questionNote?.startsWith("Sensitive message hidden"))).toBe(true);
  });
  it("my stats and the leaderboard agree with the stats page", async () => {
    const me = await getMeModel(juno, ds);
    expect(me.strip.finished).toMatchObject({ value: 6, team: 19, compare: "Down from 7" });
    expect(me.strip.median).toMatchObject({ value: "26 min", diff: "12 min faster" });
    expect(me.strip.reopened).toMatchObject({ value: 1, of: 11 });
    expect(me.open.map(o => o.id)).toEqual([1051]);
    expect(me.trend.sentence).toBe("6 in week 42, against 3.2 for the average person.");
    expect(me.trend.total).toBe(41);
    const lb = await getLeaderboardModel(juno, { period: "week" }, ds);
    expect(lb.rows.map(r => r.finished)).toEqual([6, 4, 3, 3, 2]);
    expect(lb.rows.map(r => r.ranks.finished)).toEqual([1, 2, 3, 3, 5]);   // ties share a rank
    expect(lb.hiddenNote).toBe("1 hidden at their own request. The team row still counts them.");
    expect(lb.team.finished).toBe(19);
    expect(lb.matrix.team.values).toEqual([17, 14, 18, 24, 25, 23, 26, 19]);
    expect(lb.matrix.hidden?.values).toEqual([2, 1, 1, 2, 2, 2, 1, 1]);
    expect(lb.tops.find(t => t.key === "median")!.people[0].name).toBe("Leila Haddad");
    const lb8 = await getLeaderboardModel(juno, { period: "8w" }, ds);
    expect(lb8.rows.find(r => r.you)).toMatchObject({ finished: 41, firstReplies: 71, median: "29 min", reopenedText: "7 of 71" });
  });
});
