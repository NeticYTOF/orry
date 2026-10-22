/* PLAN 2.4 rules 2, 4, 5, 16: a sentinel string in a sensitive ticket never appears before the reveal; the reveal
   logs first; text leaves the caches after 10 minutes; the stats caches hold no text; outside-channel tickets are
   organizer-only and never show text. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySource, row, T0, HOUR, DAY, HELPER } from "../lib/data/testing";
import { clearAllCaches, MemoCache } from "../lib/data/cache";
import { readCaches, readHistory } from "../lib/data/reads";
import { getBoardModel } from "../lib/models/board";
import { getTicketModel, revealTicket } from "../lib/models/ticket";
import { getClosedModel } from "../lib/models/closed";
import { setLogEvent } from "../lib/models/deps";
import { clearPeopleCacheForTests } from "../lib/people";

const SENTINEL = "ZZ-SENTINEL-7781";
const helper = { accountId: 2, slackId: HELPER, role: "helper" as const, handle: "h-one", name: "Helper One" };
const organizer = { ...helper, slackId: "U0TESTA01", role: "organizer" as const };
const now = T0 + 6 * DAY;
let log: Array<[string, string | null, string | undefined]> = [];

function source() {
  return new MemorySource([
    row({ id: 1, status: "waiting_for_helper", created_at: now - 2 * HOUR, question: `I want to talk to a real person about something at home. ${SENTINEL}` }),
    row({ id: 2, status: "waiting_for_helper", created_at: now - HOUR, question: "How do I submit my build?" }),
    row({ id: 3, status: "waiting_for_helper", created_at: now - HOUR, channel: "D0DIRECT1", question: `A direct message ${SENTINEL}` }),
    row({ id: 4, status: "resolved", created_at: T0 + HOUR, resolved_at: T0 + 2 * HOUR, updated_at: T0 + 2 * HOUR, resolution: "resolved by <@U0TESTH01>", resolved_by: HELPER, question: `talk to a human please ${SENTINEL}` })
  ], { now });
}

beforeEach(() => { clearAllCaches(); clearPeopleCacheForTests(); log = []; setLogEvent((k, a, o) => { log.push([k, a, o?.reason]); }); });
afterEach(() => { vi.useRealTimers(); });

describe("sensitive text is withheld until a logged reveal", () => {
  it("never appears in the board model, the polling JSON shape, the ticket model or the ledger", async () => {
    const ds = source();
    const board = await getBoardModel(helper, {}, ds);
    expect(JSON.stringify(board)).not.toContain(SENTINEL);
    expect(board.rows.find(r => r.id === 1)!.questionNote).toBe("Sensitive topic. Open the ticket to read it.");
    expect(board.rows.find(r => r.id === 2)!.question).toBe("How do I submit my build?");
    const t = await getTicketModel(helper, 1, ds);
    expect(JSON.stringify(t)).not.toContain(SENTINEL);
    expect(t!.question).toMatchObject({ state: "withheld_sensitive", text: null, revealPath: "/api/tickets/1/reveal" });
    const closed = await getClosedModel(helper, { week: "2026-W42" }, ds);
    expect(JSON.stringify(closed)).not.toContain(SENTINEL);
  });
  it("writes the access log row before returning the text", async () => {
    const ds = source();
    const order: string[] = [];
    setLogEvent((k) => { order.push(`log:${k}`); });
    const r = await revealTicket(helper, 1, ds);
    order.push("returned");
    expect(r.ok && r.text).toContain(SENTINEL);
    expect(order).toEqual(["log:ticket_reveal", "returned"]);
  });
  it("returns nothing when the log cannot be written", async () => {
    setLogEvent(() => { throw new Error("db locked"); });
    expect(await revealTicket(helper, 1, source())).toEqual({ ok: false, reason: "unavailable" });
  });
  it("logs ticket views", async () => {
    await getTicketModel(helper, 2, source());
    expect(log).toContainEqual(["ticket_view", HELPER, "ticket 2"]);
  });
});

describe("tickets outside the program's channels", () => {
  it("are hidden from helpers and shown to organizers without text or a Slack link", async () => {
    const ds = source();
    expect((await getBoardModel(helper, {}, ds)).rows.some(r => r.id === 3)).toBe(false);
    expect(await getTicketModel(helper, 3, ds)).toBeNull();
    clearAllCaches();
    const org = await getBoardModel(organizer, {}, ds);
    const r3 = org.rows.find(r => r.id === 3)!;
    expect(r3).toMatchObject({ question: null, slackUrl: null });
    expect(JSON.stringify(org)).not.toContain(SENTINEL);
    expect(await revealTicket(organizer, 3, ds)).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("caches", () => {
  it("drop ticket text 10 minutes after the fetch, and keep the numbers", async () => {
    let t = 0;
    const c = new MemoCache<{ q: string; n: number }>("x", { ttlMs: 30_000, dropText: v => ({ ...v, q: "" }) }, () => t);
    await c.get("k", async () => ({ q: SENTINEL, n: 7 }));
    t = 9 * 60_000;
    expect(c.peek("k")!.value.q).toBe(SENTINEL);
    t = 10 * 60_000;
    expect(c.peek("k")!.value).toEqual({ q: "", n: 7 });
  });
  it("hold no question, summary or resolution text in the statistics rows", async () => {
    const ds = source();
    await readHistory(ds, T0, T0 + 7 * DAY);
    const { historyCache } = readCaches();
    for (const k of historyCache.keys()) {
      const v = historyCache.peek(k)!.value;
      expect(JSON.stringify(v.finished)).not.toContain(SENTINEL);
      expect(JSON.stringify(v.created)).not.toContain(SENTINEL);
      expect(v.finished.every(r => !("question" in r) && !("resolution" in r))).toBe(true);
    }
  });
});
