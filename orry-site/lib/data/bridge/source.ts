/* The real data source (ORRY_FIXTURES=0): Core's bridge for program "loadout", read-only.
   Routes used (orry-bot-patched branch site-bridge-changes adds access G27, closing G9, newest events G10, G29, G31):
   GET /internal/v1/health, /programs, /programs/loadout/{tickets/search, tickets/:id, wait, helpers, access, tickets/closing,
   members}, POST /internal/v1/slack/users/info (names, in batches of 20). Checked against the real routes with
   scripts/bridge-check.ts and `bun run dev:bridge`; test/data-bridge-contract.test.ts replays what that script recorded. */
import type { ClosingInfo, DataSource, Health, Person, ProgramConfig, SlackUserInfo, TicketDetail, TicketPage, TicketSearch, WaitEstimate } from "../types";
import { DataError, isDataError } from "../types";
import { BridgeClient } from "./client";
import { AccessSchema, ClosingSchema, MembersSchema, DetailSchema, HealthSchema, HelpersSchema, ProgramsSchema, SearchSchema, UsersInfoSchema, WaitSchema, parseLoadout } from "./schemas";
import { stripEvent } from "../strip";

const P = "/internal/v1/programs/loadout";

const HOUR = 3_600_000;
/** New access-route lookups one organizersAmong() call may make (the rest wait for the next call). */
const ORGANIZER_LOOKUPS_PER_CALL = 8;

export class BridgeSource implements DataSource {
  readonly mode = "bridge" as const;
  private lastGood: number | null = null;
  private namesOk = true;
  /** Access-route answers by Slack ID (an hour), so organizers can join the roster: Core has no route that lists admins. */
  private accessSeen = new Map<string, { admin: boolean; helper: boolean; at: number }>();
  constructor(readonly client: BridgeClient = new BridgeClient()) {}

  now(): number { return Date.now(); }

  private good<T>(v: T): T { this.lastGood = Date.now(); return v; }

  async health(): Promise<Health> {
    const at = new Date().toISOString();
    try {
      await this.client.call("health", "/internal/v1/health", { schema: HealthSchema });
      const program = await this.program().catch(() => null);
      const open = await this.searchTickets({ statusGroup: "open", limit: 1 }).then(r => r.total).catch(() => null);
      this.good(true);
      return {
        ok: true, mode: "bridge", checkedAt: at, lastPollAt: new Date(this.lastGood!).toISOString(), openTickets: open,
        message: "Orry answered.", usersReadGranted: this.namesOk, ticketCardsOn: !!program?.organizerChannel,
        waitLimitMinutes: program?.sla?.waitingMs ? Math.round(program.sla.waitingMs / 60_000) : null
      };
    } catch (e) {
      const de = isDataError(e) ? e : new DataError("error", "Orry could not be checked.");
      return {
        ok: false, mode: "bridge", checkedAt: at, lastPollAt: this.lastGood ? new Date(this.lastGood).toISOString() : null, openTickets: null,
        message: de.message, usersReadGranted: this.namesOk, ticketCardsOn: false, waitLimitMinutes: null
      };
    }
  }

  async access(slackId: string): Promise<{ admin: boolean; helper: boolean } | null> {
    if (!/^[UW][A-Z0-9]{2,20}$/.test(slackId)) return { admin: false, helper: false };
    try {
      const r = await this.client.call("access", `${P}/access`, { query: { userId: slackId }, schema: AccessSchema });
      if (r) this.accessSeen.set(slackId, { admin: r.admin, helper: r.helper, at: Date.now() });
      return r ? this.good({ admin: r.admin, helper: r.helper }) : null;
    } catch (e) {
      // Before G27 is deployed: helper from the active roster; admin cannot be known, so it is false.
      if (isDataError(e) && e.kind === "needs_update") {
        try {
          const list = await this.client.call("helpers", `${P}/helpers`, { schema: HelpersSchema });
          const row = (list ?? []).find(h => h.user_id === slackId && (h.active === 1 || h.active === true));
          return { admin: false, helper: !!row };
        } catch { return null; }
      }
      return null;
    }
  }

  private toPerson(u: SlackUserInfo): Person {
    const handle = u.username ?? u.slackId;
    return { id: u.slackId, handle, name: u.displayName ?? u.realName ?? handle };
  }

  async getSlackUser(slackId: string): Promise<Person | null> {
    const r = await this.usersInfo([slackId]).catch(() => ({} as Record<string, SlackUserInfo | null>));
    const u = r[slackId];
    return u ? this.toPerson(u) : null;
  }
  /**
   * People in Loadout's organizer channel (the bot's members route; no workspace-wide list exists). [] when missing.
   * `words` holds the display name and the real name: Slack display names are often the handle, so a search for a
   * first name has to look at the real name too.
   */
  private async members(): Promise<Array<Person & { words: string[] }>> {
    try {
      const r = await this.client.call("members", `${P}/members`, { schema: MembersSchema });
      return (r?.members ?? []).map(m => ({
        id: m.id, handle: m.handle ?? m.id, name: m.displayName ?? m.realName ?? m.handle ?? m.id,
        words: [m.displayName, m.realName].filter((x): x is string => !!x).flatMap(x => x.toLowerCase().split(/[\s._-]+/)).filter(Boolean)
      }));
    } catch { return []; }
  }
  async findSlackUserByHandle(handle: string): Promise<Person | null> {
    const h = handle.replace(/^@/, "").toLowerCase().trim();
    const m = (await this.members()).find(p => p.handle.toLowerCase() === h);
    return m ? { id: m.id, handle: m.handle, name: m.name } : null;
  }
  async searchSlackUsers(query: string, limit = 8): Promise<Person[]> {
    const q = query.replace(/^@/, "").toLowerCase().trim();
    if (!q) return [];
    return (await this.members())
      .filter(p => p.handle.toLowerCase().startsWith(q) || p.words.some(w => w.startsWith(q)))
      .slice(0, limit)
      .map(p => ({ id: p.id, handle: p.handle, name: p.name }));
  }

  /**
   * Core's helpers route (active rows), plus the organizers the access route confirmed in the last hour (see
   * organizersAmong). An organizer who is also on the helper list is listed once, as an organizer.
   */
  async roster(): Promise<Array<Person & { role: "helper" | "organizer" }>> {
    const list = (await this.client.call("helpers", `${P}/helpers`, { schema: HelpersSchema })) ?? [];
    const active = list.filter(h => h.active === 1 || h.active === true);
    const admins = this.confirmedAdmins();
    const ids = [...new Set([...active.map(h => h.user_id), ...admins])];
    const names = await this.usersInfo(ids).catch(() => ({} as Record<string, SlackUserInfo | null>));
    return this.good(ids.map(id => {
      const u = names[id];
      const p = u ? this.toPerson(u) : { id, handle: id, name: id };
      const row = active.find(h => h.user_id === id);
      const organizer = admins.includes(id) || row?.role === "organizer" || row?.role === "owner";
      return { ...p, role: organizer ? "organizer" as const : "helper" as const };
    }));
  }

  private confirmedAdmins(): string[] {
    const now = Date.now();
    return [...this.accessSeen].filter(([, a]) => a.admin && now - a.at < HOUR).map(([id]) => id);
  }

  /** Asks the access route about IDs it has not seen in the last hour (at most 8 per call, to stay inside the 30 calls a minute). Failures count as "not known". */
  async organizersAmong(ids: string[]): Promise<string[]> {
    const now = Date.now();
    const todo = [...new Set(ids.filter(id => /^[UW][A-Z0-9]{2,20}$/.test(id)))].filter(id => { const a = this.accessSeen.get(id); return !a || now - a.at >= HOUR; });
    for (const id of todo.slice(0, ORGANIZER_LOOKUPS_PER_CALL)) {
      try {
        const r = await this.client.call("access", `${P}/access`, { query: { userId: id }, schema: AccessSchema });
        if (r) this.accessSeen.set(id, { admin: r.admin, helper: r.helper, at: Date.now() });
      } catch (e) {
        if (isDataError(e) && (e.kind === "needs_update" || e.kind === "rate_limited")) break;
      }
    }
    return [...new Set(ids)].filter(id => this.accessSeen.get(id)?.admin === true);
  }

  async searchTickets(q: TicketSearch): Promise<TicketPage> {
    const r = await this.client.call("search", `${P}/tickets/search`, { query: { ...q }, schema: SearchSchema });
    const page = r ?? { total: 0, rows: [] };
    return this.good({ total: page.total, rows: page.rows.filter(t => t.program_id === "loadout") });
  }

  async ticketDetail(id: number): Promise<TicketDetail | null> {
    if (!Number.isInteger(id) || id <= 0 || id > 999_999_999) return null;
    const r = await this.client.call("detail", `${P}/tickets/${id}`, { query: { eventsLimit: 200 }, schema: DetailSchema, allow404: true });
    if (!r || r.ticket.program_id !== "loadout") return null;
    const events = r.events.map(e => stripEvent({ ...e, actor_id: e.actor_id ?? null, detail: e.detail ?? null }));
    // G10 tells itself apart by its paging facts: the newest page, oldest-first. Before G10: the oldest 100.
    const g10 = r.eventsTotal !== undefined || r.eventsHasOlder !== undefined;
    return this.good({
      ticket: r.ticket,
      events,
      notes: r.notes,
      eventsTruncated: g10 ? (r.eventsHasOlder ?? (r.eventsTotal ?? 0) > events.length) : events.length >= 100,
      eventsWindow: g10 ? "newest" as const : "oldest" as const,
      eventsTotal: r.eventsTotal ?? null
    });
  }

  async waitEstimate(): Promise<WaitEstimate> {
    const r = await this.client.call("wait", `${P}/wait`, { schema: WaitSchema });
    if (!r || !r.available) return { available: false, reason: (r && "reason" in r && r.reason) || "insufficient history", sampleSize: (r && r.sampleSize) || 0 };
    return this.good({ available: true, medianWaitMs: r.medianWaitMs, sampleSize: r.sampleSize, windowDays: r.windowDays ?? 7 });
  }

  /** Filters the global programs list to Loadout before anything else sees it (PLAN 6.2). */
  async program(): Promise<ProgramConfig> {
    const all = await this.client.call("programs", "/internal/v1/programs", { schema: ProgramsSchema });
    let p: ProgramConfig | null = null;
    try { p = parseLoadout(all ?? []); } catch { throw new DataError("shape", "Orry's program settings did not have the expected shape.", "programs"); }
    if (!p) throw new DataError("error", "Orry has no program called loadout.", "programs");
    return this.good(p);
  }

  async usersInfo(ids: string[]): Promise<Record<string, SlackUserInfo | null>> {
    const uniq = [...new Set(ids.filter(id => /^[UW][A-Z0-9]{2,20}$/.test(id)))];
    const out: Record<string, SlackUserInfo | null> = {};
    for (let i = 0; i < uniq.length; i += 20) {
      const batch = uniq.slice(i, i + 20);
      const r = await this.client.call("usersInfo", "/internal/v1/slack/users/info", { body: { userIds: batch }, schema: UsersInfoSchema, cost: Math.ceil(batch.length / 5), timeoutMs: 15_000 });
      const users = r?.users ?? {};
      for (const id of batch) out[id] = users[id] ?? null;
      if (batch.length && batch.every(id => !users[id])) this.namesOk = false; else if (batch.length) this.namesOk = true;
    }
    return out;
  }

  /** G9. null when the route is not deployed. */
  async closings(sinceMs: number, untilMs: number): Promise<ClosingInfo[] | null> {
    const out: ClosingInfo[] = [];
    try {
      for (let offset = 0, page = 0; page < 10; page++) {
        const r = await this.client.call("closing", `${P}/tickets/closing`, { query: { since: sinceMs - 1, until: untilMs - 1, limit: 500, offset }, schema: ClosingSchema });
        if (!r) break;
        for (const row of r.rows) {
          const c = row.closing;
          out.push({
            ticketId: row.id, eventType: c ? c.event : null, actorKind: c ? c.actorKind : null, actorId: c?.actorId ?? null,
            source: c?.source ?? null, rule: c?.rule ?? null, verdict: c?.verdict ?? null, confidence: c?.confidence ?? null, macro: null
          });
        }
        offset += r.rows.length;
        // `total` decides (SITE-BRIDGE.md: "Page it with limit=500; total tells you when you are done"), not a short page
        if (!r.rows.length || offset >= r.total) break;
      }
      return this.good(out);
    } catch (e) {
      if (isDataError(e) && e.kind === "needs_update") return null;
      throw e;
    }
  }
}
