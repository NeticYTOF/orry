/* The bridge client and BridgeSource against a fake fetch (fake data only, nothing touches a real bot). */
import { describe, expect, it } from "vitest";
import { BridgeClient, ROUTES } from "../lib/data/bridge/client";
import { BridgeSource } from "../lib/data/bridge/source";
import { SearchSchema } from "../lib/data/bridge/schemas";
import { stripDetail } from "../lib/data/strip";
import { MemoCache } from "../lib/data/cache";
import { row } from "../lib/data/testing";
import { reopenFromEvents, staffCandidates, withOrganizers, type RosterInfo } from "../lib/data/reads";

type Call = { url: string; method: string; auth: string | null; body: string | null };
type Reply = { status: number; body: unknown };
function fakeFetch(handler: (u: URL, init: RequestInit) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    calls.push({ url: u.pathname + u.search, method: init.method ?? "GET", auth: (init.headers as Record<string, string>)?.authorization ?? null, body: (init.body as string) ?? null });
    const r = await handler(u, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
const client = (h: Parameters<typeof fakeFetch>[0], token: string | undefined = "test-token-not-real") => {
  const ff = fakeFetch(h);
  return { c: new BridgeClient({ baseUrl: () => "http://127.0.0.1:4100", token: () => token, fetchImpl: ff.f }), calls: ff.calls };
};

describe("allow-list and parameters", () => {
  it("has GET routes only, plus the users/info batch", () => {
    for (const [name, r] of Object.entries(ROUTES)) expect(r.method === "GET" || name === "usersInfo").toBe(true);
    expect(ROUTES.usersInfo.method).toBe("POST");
  });
  it("refuses paths outside the allow-list and parameters that are not whitelisted", async () => {
    const { c } = client(() => ({ status: 200, body: { total: 0, rows: [] } }));
    await expect(c.call("search", "/internal/v1/programs/other/tickets/search", { schema: SearchSchema })).rejects.toThrow(/allow-list/);
    await expect(c.call("search", "/internal/v1/tickets/1/claim", { schema: SearchSchema })).rejects.toThrow(/allow-list/);
    await expect(c.call("search", "/internal/v1/programs/loadout/tickets/search", { query: { actorId: "U1" }, schema: SearchSchema })).rejects.toThrow(/not allowed/);
  });
  it("clamps limits and drops bad values; program fixed to loadout; sends the read token", async () => {
    const { c, calls } = client(() => ({ status: 200, body: { total: 0, rows: [] } }));
    await c.call("search", "/internal/v1/programs/loadout/tickets/search", { query: { limit: 5000, offset: -3, status: "nonsense", sort: "waiting" }, schema: SearchSchema });
    expect(calls[0].url).toBe("/internal/v1/programs/loadout/tickets/search?limit=200&offset=0&sort=waiting");
    expect(calls[0].auth).toBe("Bearer test-token-not-real");
  });
  it("sends no Authorization header when the site holds no token (the forwarding proxy adds it)", async () => {
    const { c, calls } = client(() => ({ status: 200, body: { ok: true } }), "");
    await c.call("health", "/internal/v1/health", { schema: (await import("../lib/data/bridge/schemas")).HealthSchema });
    expect(calls[0].auth).toBeNull();
  });
  it("shares one call between concurrent identical reads", async () => {
    const { c, calls } = client(async () => { await new Promise(r => setTimeout(r, 20)); return { status: 200, body: { total: 0, rows: [] } }; });
    const p = "/internal/v1/programs/loadout/tickets/search";
    await Promise.all([1, 2, 3].map(() => c.call("search", p, { query: { limit: 10 }, schema: SearchSchema })));
    expect(calls).toHaveLength(1);
  });
});

describe("errors become panel states, never wrong numbers", () => {
  const p = "/internal/v1/programs/loadout/tickets/search";
  it("maps 404 internal api disabled, 401, a missing G-route, a shape mismatch and a timeout", async () => {
    await expect(client(() => ({ status: 404, body: { error: "internal api disabled" } })).c.call("search", p, { schema: SearchSchema })).rejects.toMatchObject({ kind: "not_connected" });
    await expect(client(() => ({ status: 401, body: { error: "unauthorized" } })).c.call("search", p, { schema: SearchSchema })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(client(() => ({ status: 404, body: { error: "not found" } })).c.call("closing", "/internal/v1/programs/loadout/tickets/closing", { schema: SearchSchema })).rejects.toMatchObject({ kind: "needs_update", gap: "G9" });
    await expect(client(() => ({ status: 200, body: { total: "lots", rows: [] } })).c.call("search", p, { schema: SearchSchema })).rejects.toMatchObject({ kind: "shape" });
    const slow = new BridgeClient({ baseUrl: () => "http://127.0.0.1:4100", fetchImpl: ((_: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch });
    await expect(slow.call("search", p, { schema: SearchSchema, timeoutMs: 30 })).rejects.toMatchObject({ kind: "timeout" });
    await expect(new BridgeClient({ baseUrl: () => undefined }).call("search", p, { schema: SearchSchema })).rejects.toMatchObject({ kind: "not_connected" });
  });
  it("opens the circuit after 3 failures in a row", async () => {
    let n = 0;
    const { c } = client(() => { n++; return { status: 500, body: {} }; });
    for (let i = 0; i < 3; i++) await expect(c.call("search", p, { query: { offset: i }, schema: SearchSchema })).rejects.toMatchObject({ kind: "error" });
    await expect(c.call("search", p, { query: { offset: 9 }, schema: SearchSchema })).rejects.toMatchObject({ kind: "offline" });
    expect(n).toBe(3);
  });
  it("keeps the last good copy as stale for outages, but not for shape errors", async () => {
    const cache = new MemoCache<number>("t", { ttlMs: 0 });
    await cache.get("k", async () => 1);
    const { DataError } = await import("../lib/data/types");
    const stale = await cache.get("k", async () => { throw new DataError("offline", "down"); });
    expect(stale).toMatchObject({ value: 1, stale: true });
    await expect(cache.get("k", async () => { throw new DataError("shape", "bad"); })).rejects.toMatchObject({ kind: "shape" });
  });
});

describe("BridgeSource", () => {
  it("filters the global programs route to loadout before anything else sees it", async () => {
    const { c } = client(u => u.pathname === "/internal/v1/programs"
      ? { status: 200, body: [{ id: "other", name: "Other", channels: ["C0OTHER1"], secretThing: "x" }, { id: "loadout", name: "Loadout", channels: ["C0LOADHLP1"], ticketVisibility: "thread", publicTicketsEnabled: true, autoAssign: true, sla: { unassignedMs: null, assignedMs: null, waitingMs: null }, retention: { ticketsDays: 180 } }] }
      : { status: 404, body: { error: "not found" } });
    const p = await new BridgeSource(c).program();
    expect(p).toMatchObject({ id: "loadout", channels: ["C0LOADHLP1"], sla: null, retentionDays: 180, organizerChannel: null });
    expect(JSON.stringify(p)).not.toContain("Other");
  });
  it("drops rows of other programs, strips event text and reads eventsHasOlder", async () => {
    const t = row({ id: 7 });
    const { c } = client(u => {
      if (u.pathname.endsWith("/tickets/search")) return { status: 200, body: { total: 2, rows: [t, { ...t, id: 8, program_id: "other" }] } };
      return { status: 200, body: { ticket: t, events: [{ id: 1, ticket_id: 7, actor_id: "U0REQ0001", event_type: "requester_followup", detail: JSON.stringify({ text: "private words" }), created_at: 1 }, { id: 2, ticket_id: 7, actor_id: null, event_type: "resolved", detail: JSON.stringify({ source: "auto", verdict: "resolved", confidence: 0.9, reason: "the kid said thanks" }), created_at: 2 }], notes: [], eventsHasOlder: true } };
    });
    const s = new BridgeSource(c);
    expect((await s.searchTickets({ statusGroup: "open" })).rows.map(r => r.id)).toEqual([7]);
    const d = (await s.ticketDetail(7))!;
    expect(d.eventsTruncated).toBe(true);
    expect(JSON.stringify(d.events)).not.toMatch(/private words|said thanks/);
    expect(d.events[1].detail).toEqual({ source: "auto", verdict: "resolved", confidence: 0.9 });
  });
  it("falls back to the helper roster for access when G27 is not deployed, and fails closed on errors", async () => {
    const { c } = client(u => u.pathname.endsWith("/access") ? { status: 404, body: { error: "not found" } } : { status: 200, body: [{ user_id: "U0HELP001", role: "helper", active: 1 }] });
    const s = new BridgeSource(c);
    expect(await s.access("U0HELP001")).toEqual({ admin: false, helper: true });
    expect(await s.access("U0NOBODY1")).toEqual({ admin: false, helper: false });
    const down = new BridgeSource(client(() => ({ status: 500, body: {} })).c);
    expect(await down.access("U0HELP001")).toBeNull();
  });
  it("searches invite candidates through the members route, and finds nobody when it is missing", async () => {
    const { c } = client(() => ({ status: 200, body: { members: [{ id: "U0MEM0001", handle: "brass-owl", realName: "Robin Test", displayName: null }, { id: "U0MEM0002", handle: "tin-owl", realName: null, displayName: "Kim Test" }] } }));
    const s = new BridgeSource(c);
    expect((await s.searchSlackUsers("@robin")).map(p => p.id)).toEqual(["U0MEM0001"]);
    expect((await s.findSlackUserByHandle("@tin-owl"))?.name).toBe("Kim Test");
    const none = new BridgeSource(client(() => ({ status: 404, body: { error: "not found" } })).c);
    expect(await none.searchSlackUsers("robin")).toEqual([]);
  });
  it("names come from users/info in batches of 20", async () => {
    const { c, calls } = client((_u, init) => {
      const ids = JSON.parse(String(init.body)).userIds as string[];
      return { status: 200, body: { users: Object.fromEntries(ids.map(id => [id, { slackId: id, displayName: "Name", realName: null, username: "handle", avatarUrl: null }])) } };
    });
    const ids = Array.from({ length: 45 }, (_, i) => `U0TEST${String(i).padStart(3, "0")}`);
    const r = await new BridgeSource(c).usersInfo(ids);
    expect(Object.keys(r)).toHaveLength(45);
    expect(calls.map(x => JSON.parse(x.body!).userIds.length)).toEqual([20, 20, 5]);
    expect(calls.every(x => x.method === "POST")).toBe(true);
  });
});

describe("event detail whitelist", () => {
  it("keeps short labels and IDs only", () => {
    expect(stripDetail({ text: "hi", by: "requester", to: "U0ABC123", reason: "a long sentence", noteId: 4, suggested: ["U0ABC123", "not an id"] })).toEqual({ by: "requester", to: "U0ABC123", suggested: ["U0ABC123"] });
    expect(stripDetail("{bad json")).toBeNull();
    expect(stripDetail({ to: "Some Name" })).toBeNull();
  });
});

/* Fixes found by running the site against the real bot routes (scripts/bridge-check.ts, `bun run dev:bridge`). */
describe("against the real routes", () => {
  it("counts organizers as staff: the access route adds them, the helpers route alone does not", async () => {
    const { c, calls } = client(u => {
      if (u.pathname.endsWith("/helpers")) return { status: 200, body: [{ user_id: "U0HELP001", role: "helper", active: 1 }] };
      if (u.pathname.endsWith("/access")) return { status: 200, body: { admin: u.searchParams.get("userId") === "U0ORG0001", helper: false } };
      return { status: 200, body: { users: {} } };
    });
    const s = new BridgeSource(c);
    const roster: RosterInfo = { ids: new Set(["U0HELP001"]), helpers: ["U0HELP001"], organizers: [] };
    const r = await withOrganizers(s, roster, staffCandidates([row({ assignee_id: "U0ORG0001", first_responder_id: "U0HELP001", resolved_credit_id: "U0KIDX001" })]));
    expect(r.organizers).toEqual(["U0ORG0001"]);
    expect(r.ids.has("U0ORG0001")).toBe(true);
    // only people not on the roster are asked, once an hour
    expect(calls.filter(x => x.url.includes("/access")).map(x => x.url)).toEqual(["/internal/v1/programs/loadout/access?userId=U0ORG0001", "/internal/v1/programs/loadout/access?userId=U0KIDX001"]);
    await withOrganizers(s, roster, ["U0ORG0001"]);
    expect(calls.filter(x => x.url.includes("/access"))).toHaveLength(2);
    expect((await s.roster()).find(p => p.id === "U0ORG0001")?.role).toBe("organizer");
    // a source without organizersAmong keeps its roster as it is
    const plain = { organizersAmong: undefined } as unknown as Parameters<typeof withOrganizers>[0];
    expect(await withOrganizers(plain, roster, ["U0ORG0001"])).toBe(roster);
  });
  it("finds invite candidates by real name when the display name is the handle", async () => {
    const { c } = client(() => ({ status: 200, body: { members: [{ id: "U0MEM0003", handle: "pixel-otter", realName: "Juno Baker", displayName: "pixel-otter" }] } }));
    expect((await new BridgeSource(c).searchSlackUsers("jun")).map(p => p.id)).toEqual(["U0MEM0003"]);
  });
  it("reads G10's newest-events window: a reopen inside the page is decided, one before it is unknown", async () => {
    const t = row({ id: 9, status: "reopened", reopened_at: 5_000 });
    const ev = (id: number, type: string, at: number, actor: string | null = null) => ({ id, ticket_id: 9, actor_id: actor, event_type: type, detail: null, created_at: at });
    const { c } = client(() => ({ status: 200, body: { ticket: t, events: [ev(40, "helper_reply", 4_000, "U0HELP001"), ev(41, "reopened", 5_000), ev(42, "requester_followup", 6_000)], notes: [], eventsTotal: 42, eventsOffset: 0, eventsLimit: 3, eventsHasOlder: true } }));
    const d = (await new BridgeSource(c).ticketDetail(9))!;
    expect(d).toMatchObject({ eventsWindow: "newest", eventsTotal: 42, eventsTruncated: true });
    expect(reopenFromEvents(d, 5_000, new Set(["U0HELP001"])).humanSince).toBe(false);
    expect(reopenFromEvents(d, 3_000, new Set(["U0HELP001"])).humanSince).toBe(true);
    expect(reopenFromEvents({ ...d, events: d.events.slice(1) }, 4_500, new Set(["U0HELP001"])).humanSince).toBe("unknown");
    // before G10 (no paging facts): the oldest 100, so a truncated list can't decide
    expect(reopenFromEvents({ ...d, eventsWindow: "oldest" }, 5_000, new Set()).humanSince).toBe("unknown");
  });
  it("keeps the macro trigger word Core stores as `trigger`", () => {
    expect(stripDetail(JSON.stringify({ macroId: 1, trigger: "?wrapup" }))).toEqual({ macro: "?wrapup" });
    expect(stripDetail({ trigger: "a whole sentence of text here" })).toBeNull();
  });
});
