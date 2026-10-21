/* The site's bridge path against responses recorded from the real bot code (`bun run dev:bridge` in orry-bot-patched,
   invented data only), so contract drift is caught without a running bridge. Re-record with:
     ORRY_FIXTURES=0 RIVET_CORE_BASE_URL=http://127.0.0.1:4100 RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token \
       npx tsx scripts/bridge-check.ts --record test/fixtures/bridge */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { BridgeClient } from "../lib/data/bridge/client";
import { BridgeSource } from "../lib/data/bridge/source";
import { AccessSchema, ClosingSchema, DetailSchema, HealthSchema, HelpersSchema, MembersSchema, ProgramsSchema, SearchSchema, UsersInfoSchema, WaitSchema, parseLoadout } from "../lib/data/bridge/schemas";
import { runBridgeChecks, type CheckSummary } from "../lib/data/bridge/check";
import { clearAllCaches } from "../lib/data/cache";
import { clearPeopleCacheForTests } from "../lib/people";
import { getTicketModel } from "../lib/models/ticket";
import { CHECK_HELPER, CHECK_ORGANIZER } from "../lib/data/bridge/check";
import { setLogEvent } from "../lib/models/deps";

type Recorded = { key: string; method: string; path: string; body: string | null; status: number; json: unknown };
const dir = path.join(__dirname, "fixtures", "bridge");
const rec = JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8")) as { recordedAt: number; responses: Recorded[] };
const expected = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")) as CheckSummary;
const byKey = new Map(rec.responses.map(r => [r.key, r]));
const pathOnly = (r: Recorded) => r.path.split("?")[0];

/* Every Slack user any recorded users/info batch named, so a batch in another order still gets its answer. */
const users: Record<string, unknown> = {};
for (const r of rec.responses) if (pathOnly(r) === "/internal/v1/slack/users/info") Object.assign(users, (r.json as { users: Record<string, unknown> }).users);

type Reply = { status: number; json: unknown };
function replayFetch(o: { misses: string[]; closingPage?: number }) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : null;
    let reply: Reply | undefined;
    if (u.pathname === "/internal/v1/slack/users/info") {
      const ids = (JSON.parse(body ?? "{}") as { userIds?: string[] }).userIds ?? [];
      reply = { status: 200, json: { users: Object.fromEntries(ids.map(id => [id, users[id] ?? null])) } };
    } else if (o.closingPage && u.pathname.endsWith("/tickets/closing")) {
      // the same recorded rows, served as a bot that clamps every page to `closingPage` rows
      const full = [...byKey.values()].find(r => r.path.startsWith(`${u.pathname}?since=${u.searchParams.get("since")}&until=${u.searchParams.get("until")}&`));
      if (full) {
        const all = full.json as { total: number; rows: unknown[] };
        const offset = Number(u.searchParams.get("offset") ?? 0);
        reply = { status: 200, json: { ...all, limit: o.closingPage, offset, rows: all.rows.slice(offset, offset + o.closingPage) } };
      }
    } else {
      const r = byKey.get(`${method} ${u.pathname}${u.search}${body ? ` ${body}` : ""}`);
      if (r) reply = { status: r.status, json: r.json };
    }
    if (!reply) { o.misses.push(`${method} ${u.pathname}${u.search}`); reply = { status: 503, json: { error: "not recorded" } }; }
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const source = (o: { misses: string[]; closingPage?: number }) =>
  new BridgeSource(new BridgeClient({ baseUrl: () => "http://127.0.0.1:4100", token: () => "replay-token-not-real", fetchImpl: replayFetch(o), perMinute: 10_000 }));

beforeAll(() => { vi.useFakeTimers({ now: rec.recordedAt, toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); clearAllCaches(); clearPeopleCacheForTests(); setLogEvent(null); });

describe("recorded bridge responses match the site's schemas", () => {
  const schemaFor = (r: Recorded): z.ZodTypeAny | null => {
    const p = pathOnly(r);
    if (p === "/internal/v1/health") return HealthSchema;
    if (p === "/internal/v1/programs") return ProgramsSchema;
    if (p === "/internal/v1/slack/users/info") return UsersInfoSchema;
    if (p.endsWith("/tickets/search")) return SearchSchema;
    if (p.endsWith("/tickets/closing")) return ClosingSchema;
    if (/\/tickets\/\d+$/.test(p)) return DetailSchema;
    if (p.endsWith("/access")) return AccessSchema;
    if (p.endsWith("/helpers")) return HelpersSchema;
    if (p.endsWith("/members")) return MembersSchema;
    if (p.endsWith("/wait")) return WaitSchema;
    return null;
  };
  it.each(rec.responses.map(r => [r.key.slice(0, 120), r] as const))("%s", (_k, r) => {
    expect(r.status).toBe(200);
    const s = schemaFor(r);
    expect(s, "a route the site does not read was recorded").not.toBeNull();
    const parsed = s!.safeParse(r.json);
    expect(parsed.success ? null : parsed.error.issues.slice(0, 3)).toBeNull();
  });
  it("the programs route has Loadout with its channels and organizer channel", () => {
    const p = parseLoadout(byKey.get("GET /internal/v1/programs")!.json as Array<Record<string, unknown>>);
    expect(p?.channels.length).toBeGreaterThan(0);
    expect(p?.organizerChannel).toMatch(/^C/);
  });
  it("the closing route carries the documented fields and never the requester or any text", () => {
    const r = rec.responses.find(x => pathOnly(x).endsWith("/tickets/closing"))!;
    const body = r.json as { total: number; limit: number; offset: number; rows: Array<Record<string, unknown>> };
    expect(body.rows.length).toBe(body.total);
    for (const row of body.rows) {
      for (const k of ["id", "status", "ownerId", "creditedId", "createdAt", "resolvedAt", "firstHumanResponseAt", "lastHumanReplyAt", "reopenCount", "closing", "firstTaken", "pings"]) expect(row, k).toHaveProperty(k);
      for (const k of ["question", "resolution", "requesterId", "requester_id", "reason", "text"]) expect(row).not.toHaveProperty(k);
      const c = row.closing as Record<string, unknown> | null;
      if (c) { expect(c).not.toHaveProperty("reason"); if (c.actorKind === "requester") expect(c.actorId).toBeNull(); }
    }
  });
});

describe("the site's bridge path over the recorded responses", () => {
  it("gives the same headline numbers as the live run, with no failures", async () => {
    const misses: string[] = [];
    const fails: string[] = [];
    const { summary } = await runBridgeChecks(source({ misses }), { line: () => {}, fail: s => fails.push(s), warn: () => {} });
    expect(fails).toEqual([]);
    // the background reopen check may ask for a ticket the recording did not need; nothing else may be missing
    expect(misses.filter(m => !/\/tickets\/\d+\?/.test(m))).toEqual([]);
    expect(summary).toEqual(expected);
  });

  it("pages the closing route until total, even when the bot sends shorter pages than asked", async () => {
    const misses: string[] = [];
    const ds = source({ misses, closingPage: 40 });
    const r = rec.responses.find(x => pathOnly(x).endsWith("/tickets/closing"))!;
    const u = new URL(`http://x${r.path}`);
    const got = await ds.closings(Number(u.searchParams.get("since")) + 1, Number(u.searchParams.get("until")) + 1);
    expect(got?.length).toBe((r.json as { total: number }).total);
    expect(got!.length).toBeGreaterThan(40);
  });

  it("reads the newest-events window (G10), the tombstone (G31) and organizer credit from the real shapes", async () => {
    const misses: string[] = [];
    const ds = source({ misses });
    clearAllCaches();
    const picked = (expected.tickets as { picked: Record<string, number> }).picked;
    const d = await ds.ticketDetail(picked.reopened);
    expect(d?.eventsWindow).toBe("newest");
    expect(d?.events.every(e => !JSON.stringify(e.detail ?? {}).includes("text"))).toBe(true);
    setLogEvent(() => {});
    const red = await getTicketModel(CHECK_HELPER, picked.redacted, ds);
    expect(red?.question.state).toBe("redacted");
    expect(red?.question.text).toBeNull();
    expect(red?.timeline.some(t => /deleted the message/.test(t.text))).toBe(true);
    expect(await getTicketModel(CHECK_HELPER, picked.outside, ds)).toBeNull();
    expect((await getTicketModel(CHECK_ORGANIZER, picked.outside, ds))?.question.state).toBe("withheld_outside");
    const stats = (expected.organizer as Record<string, { team: string[] }>)["stats last full week"];
    expect(stats.team.some(t => t.startsWith(`${CHECK_ORGANIZER.slackId}:1:`))).toBe(true);
  });
});
