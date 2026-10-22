/* The invented data source (ORRY_FIXTURES=1). Deterministic: same ORRY_NOW, same data.
   Implements Core's read routes with Core's semantics (one ORDER BY column and no id tie-break, created_at > since,
   created_at <= until, limit clamped to 1..200, oldest 100 events), so the paging code is exercised the same way. */
import type {
  ClosingInfo, DataSource, Health, Person, ProgramConfig, SlackUserInfo, TicketDetail, TicketPage, TicketRow, TicketSearch, WaitEstimate
} from "../types";
import { DataError, OPEN_STATUSES } from "../types";
import { PEOPLE, ORGANIZER_IDS, HELPER_IDS, byId, byHandle } from "./people";
import { applyPendingChanges, generateFixtures, HELP_CHANNEL, BUILD_CHANNEL, type FixtureData } from "./generate";
import { fixtureNow } from "../clock";
import { stripEvent } from "../strip";

export type FixtureState = "live" | "stale" | "offline" | "not_connected";

export type FixtureOptions = {
  now?: number;
  /** Show queue.html's pending changes (#1054 and two claims) this many ms after start. null = never. */
  pendingAfterMs?: number | null;
  state?: FixtureState;
  data?: FixtureData;
};

function envState(): FixtureState {
  const s = process.env.ORRY_FIXTURE_STATE;
  return s === "stale" || s === "offline" || s === "not_connected" ? s : "live";
}

export class FixtureSource implements DataSource {
  readonly mode = "fixtures" as const;
  readonly simulatedState: FixtureState;
  private base: FixtureData;
  private after: FixtureData | null = null;
  private readonly startedAt = Date.now();
  private readonly pendingAfterMs: number | null;

  constructor(o: FixtureOptions = {}) {
    this.base = o.data ?? generateFixtures({ now: o.now ?? fixtureNow() });
    this.pendingAfterMs = o.pendingAfterMs !== undefined ? o.pendingAfterMs : process.env.ORRY_FIXTURE_EVENTS === "0" ? null : 30_000;
    this.simulatedState = o.state ?? envState();
  }

  /** The data as of this moment: the base set, plus the pending changes once their time has come. */
  get data(): FixtureData {
    if (this.pendingAfterMs != null && Date.now() - this.startedAt >= this.pendingAfterMs) {
      this.after ??= applyPendingChanges(this.base);
      return this.after;
    }
    return this.base;
  }

  now(): number { return this.data.now; }

  private gate(): void {
    if (this.simulatedState === "not_connected") throw new DataError("not_connected", "internal api disabled");
    if (this.simulatedState === "offline") throw new DataError("offline", "Orry did not answer (simulated).");
  }

  async health(): Promise<Health> {
    const at = new Date().toISOString();
    const open = this.data.tickets.filter(t => OPEN_STATUSES.includes(t.status)).length;
    const off = this.simulatedState !== "live";
    return {
      ok: !off, mode: "fixtures", checkedAt: at, lastPollAt: this.simulatedState === "not_connected" ? null : at, openTickets: off ? null : open,
      message: off ? `Invented data, showing the ${this.simulatedState.replace("_", " ")} state.` : "Invented data. Nothing here is real.",
      usersReadGranted: true, ticketCardsOn: false, waitLimitMinutes: null
    };
  }

  async access(slackId: string) {
    return { admin: ORGANIZER_IDS.includes(slackId), helper: HELPER_IDS.includes(slackId) };
  }
  async getSlackUser(slackId: string): Promise<Person | null> { return byId(slackId) ?? null; }
  async findSlackUserByHandle(handle: string): Promise<Person | null> { return byHandle(handle) ?? null; }
  async searchSlackUsers(query: string, limit = 8): Promise<Person[]> {
    const q = query.replace(/^@/, "").toLowerCase().trim();
    if (!q) return [];
    return PEOPLE.filter(p => p.handle.startsWith(q) || p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q))).slice(0, limit);
  }
  async roster(): Promise<Array<Person & { role: "helper" | "organizer" }>> {
    const out: Array<Person & { role: "helper" | "organizer" }> = [];
    for (const id of ORGANIZER_IDS) { const p = byId(id); if (p) out.push({ ...p, role: "organizer" }); }
    for (const id of HELPER_IDS) { if (ORGANIZER_IDS.includes(id)) continue; const p = byId(id); if (p) out.push({ ...p, role: "helper" }); }
    return out;
  }

  async searchTickets(q: TicketSearch): Promise<TicketPage> {
    this.gate();
    return coreSearch(this.data.tickets, q);
  }

  async ticketDetail(id: number): Promise<TicketDetail | null> {
    this.gate();
    const ticket = this.data.tickets.find(t => t.id === id);
    if (!ticket) return null;
    const raw = [...(this.data.events.get(id) ?? [])].sort((a, b) => a.created_at - b.created_at).slice(0, 100);
    const notes = [...(this.data.notes.get(id) ?? [])].sort((a, b) => a.created_at - b.created_at).slice(0, 100);
    return { ticket: { ...ticket }, events: raw.map(stripEvent), notes, eventsTruncated: raw.length >= 100, eventsWindow: "oldest" };
  }

  async waitEstimate(): Promise<WaitEstimate> {
    this.gate();
    const cutoff = this.now() - 7 * 86_400_000;
    const lags = this.data.tickets
      .filter(t => t.created_at > cutoff && t.first_human_response_at != null)
      .map(t => t.first_human_response_at! - t.created_at)
      .filter(l => Number.isFinite(l) && l >= 0)
      .sort((a, b) => a - b);
    if (lags.length < 3) return { available: false, reason: "insufficient history", sampleSize: lags.length };
    return { available: true, medianWaitMs: lags[Math.floor(lags.length / 2)], sampleSize: lags.length, windowDays: 7 };
  }

  async program(): Promise<ProgramConfig> {
    this.gate();
    return {
      id: "loadout", name: "Loadout", status: "live", posture: "active", ticketVisibility: "thread", publicTicketsEnabled: true,
      channels: [HELP_CHANNEL, BUILD_CHANNEL], organizerChannel: null, autoAssign: true, sla: null, retentionDays: 180
    };
  }

  async usersInfo(ids: string[]): Promise<Record<string, SlackUserInfo | null>> {
    const out: Record<string, SlackUserInfo | null> = {};
    for (const id of ids) {
      const p = byId(id) ?? this.data.participants.find(x => x.id === id);
      out[id] = p ? { slackId: id, displayName: p.name, realName: p.name === p.handle ? null : p.name, username: p.handle, avatarUrl: null } : null;
    }
    return out;
  }

  async closings(sinceMs: number, untilMs: number): Promise<ClosingInfo[] | null> {
    this.gate();
    const out: ClosingInfo[] = [];
    for (const t of this.data.tickets) {
      if ((t.status !== "resolved" && t.status !== "closed") || t.resolved_at == null) continue;
      if (t.resolved_at < sinceMs || t.resolved_at >= untilMs) continue;
      const c = this.data.closings.get(t.id);
      if (c) out.push(c);
    }
    return out;
  }
}

/** Core's `ticketSearchScoped` over an in-memory list (lib/web/dashboardApi.ts:103-184). Ties keep list order. */
export function coreSearch(all: readonly TicketRow[], q: TicketSearch): TicketPage {
  let rows = all.filter(t => t.program_id === "loadout");
  if (q.status) rows = rows.filter(t => t.status === q.status);
  else if (q.statusGroup === "open") rows = rows.filter(t => OPEN_STATUSES.includes(t.status));
  else if (q.statusGroup === "resolved") rows = rows.filter(t => t.status === "resolved");
  if (q.since) rows = rows.filter(t => t.created_at > Number(q.since));
  if (q.until) rows = rows.filter(t => t.created_at <= Number(q.until));
  const sort = q.sort === "updated" || q.sort === "waiting" ? q.sort : "created";
  const col = sort === "updated" ? "updated_at" : "created_at";
  const dir = sort === "waiting" ? 1 : -1;
  rows = [...rows].sort((a, b) => ((a[col] ?? 0) - (b[col] ?? 0)) * dir);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { total: rows.length, rows: rows.slice(offset, offset + limit).map(r => ({ ...r })) };
}
