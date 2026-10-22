/* Rules for every number (PLAN 5.1), finished-by (5.3), weeks in UTC, ranking and the grid. */
import { describe, expect, it } from "vitest";
import { p90, summary, upperMedian } from "../lib/metrics/stats";
import { BOT_COMMIT, eventLabel, finishedLabel, PREFIX, rowLabel, unclassified } from "../lib/metrics/finishedBy";
import { formatDuration, isoDuration, lastWeeks, parseWeek, weekKey, weekSpanLabel } from "../lib/metrics/time";
import { heatmap, heatStep, provisional, rank } from "../lib/metrics/week";
import { HELPER, meta, MIN, REQ, ROSTER, T0, HOUR, DAY } from "../lib/data/testing";

describe("medians and p90", () => {
  it("uses the upper median and drops negative and non-finite lags", () => {
    expect(upperMedian([1, 2, 3, 4])).toBe(3);
    expect(upperMedian([5, -2, NaN, 1, Infinity, 3])).toBe(3);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])).toBe(100);
  });
  it("hides both when n is under 5", () => {
    expect(summary([1, 2, 3, 4])).toEqual({ n: 4, median: null, p90: null, tooFew: true });
    expect(summary([1, 2, 3, 4, 5]).median).toBe(3);
  });
});

describe("finished-by row rule", () => {
  it("is pinned to the bot commit the prefixes were checked against", () => {
    expect(BOT_COMMIT).toBe("696d203");
    expect(PREFIX.lastWord).toBe("resolved: a helper had the last word");
  });
  it("reads every part from the resolution prefix and never trusts resolved_by for Orry's closes", () => {
    const base = { requester_id: REQ, resolved_by: HELPER };
    expect(rowLabel({ ...base, status: "resolved", resolution: "resolved: a helper had the last word and the requester didn't come back" })).toBe("orry_last_word");
    expect(rowLabel({ ...base, status: "resolved", resolution: "auto-resolved: it works now" })).toBe("orry_judge");
    expect(rowLabel({ ...base, status: "resolved", resolution: "resolved from historical confirmation" })).toBe("import_resolved");
    expect(rowLabel({ ...base, status: "resolved", resolution: "resolved via macro solved" })).toBe("helper");
    expect(rowLabel({ ...base, status: "resolved", resolution: `resolved by <@${REQ}>`, resolved_by: REQ })).toBe("participant");
    expect(rowLabel({ ...base, status: "closed", resolution: null })).toBe("person_or_macro");
    expect(rowLabel({ ...base, status: "reopened", resolution: null })).toBeNull();
    expect(unclassified({ ...base, status: "resolved", resolution: "closed by the new sweep" })).toBe(true);
    expect(unclassified({ ...base, status: "resolved", resolution: "auto-resolved: x" })).toBe(false);
  });
  it("prefers Orry's closing events (G9) when they are there", () => {
    const t = meta({ status: "resolved", resolution: "resolved: a helper had the last word and the requester didn't come back", resolved_by: HELPER });
    const c = { ticketId: t.id, eventType: "resolved" as const, actorKind: "orry" as const, actorId: null, source: "backfill", rule: "last_word", verdict: null, confidence: null, macro: null };
    expect(finishedLabel(t, undefined, ROSTER)).toBe("orry_last_word");      // phase 1 cannot tell an import last word
    expect(finishedLabel(t, c, ROSTER)).toBe("import_resolved");             // G9 can
    expect(eventLabel({ ...c, eventType: null, actorKind: null }, t, ROSTER)).toBe("person_or_macro");
    expect(eventLabel({ ...c, source: "auto", actorKind: "requester" }, t, ROSTER)).toBe("participant");
    expect(eventLabel({ ...c, source: "auto", eventType: "closed", actorKind: "helper", actorId: HELPER }, t, ROSTER)).toBe("person_or_macro");
    expect(eventLabel({ ...c, source: "auto", rule: null, verdict: null }, t, ROSTER)).toBeNull(); // unnamed Orry close: row rule decides
  });
});

describe("ISO weeks in UTC", () => {
  it("parses and labels week 42 of 2026", () => {
    const w = parseWeek("2026-W42")!;
    expect(new Date(w.start).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(weekSpanLabel(w)).toBe("12 to 18 Oct");
    expect(weekKey(w.end - 1)).toBe("2026-W42");
    expect(lastWeeks("2026-W02", 3)).toEqual(["2025-W52", "2026-W01", "2026-W02"]);
    expect(parseWeek("2026-W53")).not.toBeNull();   // 2026 starts on a Thursday: 53 ISO weeks
    expect(parseWeek("2027-W53")).toBeNull();
  });
  it("is provisional for 7 days after the week ends", () => {
    const w = parseWeek("2026-W42")!;
    expect(provisional(w, w.end + 6 * DAY).provisional).toBe(true);
    expect(provisional(w, w.end + 7 * DAY).provisional).toBe(false);
  });
  it("formats durations with the two largest units", () => {
    expect(formatDuration(41 * MIN, { nbsp: false })).toBe("41 min");
    expect(formatDuration(192 * MIN, { nbsp: false })).toBe("3 h 12 min");
    expect(formatDuration((2 * 24 + 4) * HOUR + 30 * MIN, { nbsp: false })).toBe("2 d 4 h");
    expect(isoDuration(312 * MIN)).toBe("PT5H12M");
  });
});

describe("ranking and the waiting grid", () => {
  it("shares ranks on ties and puts missing values last with no rank", () => {
    const rows = [{ id: "a", v: 3 }, { id: "b", v: 5 }, { id: "c", v: 3 }, { id: "d", v: null }];
    const r = rank(rows, x => x.v, "high", (x, y) => x.id.localeCompare(y.id));
    expect(r.map(x => [x.id, x.rank])).toEqual([["b", 1], ["a", 2], ["c", 2], ["d", null]]);
  });
  it("buckets tickets into 2-hour UTC blocks by weekday", () => {
    const sundayNight = meta({ created_at: T0 + 6 * DAY + 23 * HOUR + 59 * MIN });
    const mondayZero = meta({ created_at: T0 });
    const cells = heatmap([sundayNight, mondayZero]);
    expect(cells.find(c => c.day === 6 && c.block === 11)!.created).toBe(1);
    expect(cells.find(c => c.day === 0 && c.block === 0)!.created).toBe(1);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(heatStep)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
});
