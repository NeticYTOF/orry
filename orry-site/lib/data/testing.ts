/* Small factories for the metric and data tests. Invented values only. */
import type { DataSource, Health, Person, ProgramConfig, SlackUserInfo, TicketDetail, TicketEvent, TicketMeta, TicketPage, TicketRow, TicketSearch, WaitEstimate, ClosingInfo } from "./types";
import { toMeta } from "./strip";
import { coreSearch } from "./fixtures/source";

export const T0 = Date.UTC(2026, 9, 12); // Monday of ISO week 42, 2026, 00:00:00.000 UTC
export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const HELPER = "U0TESTH01", HELPER2 = "U0TESTH02", REQ = "U0TESTR01", ADMIN = "U0TESTA01";
export const ROSTER = new Set([HELPER, HELPER2, ADMIN]);

let seq = 1;
export function row(p: Partial<TicketRow> = {}): TicketRow {
  const id = p.id ?? seq++;
  return {
    id, program_id: "loadout", channel: "C0TESTHLP", thread_ts: `${Math.floor((p.created_at ?? T0) / 1000)}.000100`, card_ts: null,
    requester_id: REQ, question: "How do I submit my build?", status: "waiting_for_helper", assignee_id: null, resolution: null,
    created_at: T0, claimed_at: null, resolved_at: null, category: "review", summary: null, first_response_at: null,
    first_human_response_at: null, visibility: "thread", assigned_at: null, reopened_at: null, reopen_count: 0, snoozed_until: null,
    updated_at: p.created_at ?? T0, public_ack_ts: null, resolved_by: null, resolved_credit_id: null, reopened_by: null,
    duplicate_of: null, first_responder_id: null, notes_count: 0, ...p
  };
}
export const meta = (p: Partial<TicketRow> = {}): TicketMeta => toMeta(row(p), ["C0TESTHLP"]);

export function event(p: Partial<TicketEvent> & { event_type: string; ticket_id: number; created_at: number }): TicketEvent {
  return { id: seq++, actor_id: null, detail: null, ...p };
}

/** An in-memory DataSource with Core's search semantics. `shuffleTies` reorders equal timestamps on every call. */
export class MemorySource implements DataSource {
  readonly mode = "fixtures" as const;
  calls: TicketSearch[] = [];
  private flip = false;
  constructor(public rows: TicketRow[], public o: { now?: number; shuffleTies?: boolean; details?: Map<number, TicketDetail>; closings?: ClosingInfo[] | null; roster?: Array<Person & { role: "helper" | "organizer" }>; program?: Partial<ProgramConfig> } = {}) {}
  now() { return this.o.now ?? T0 + 6 * DAY; }
  async health(): Promise<Health> { return { ok: true, mode: "fixtures", checkedAt: "", lastPollAt: null, openTickets: null, message: "", usersReadGranted: true, ticketCardsOn: false, waitLimitMinutes: null }; }
  async access() { return { admin: false, helper: true }; }
  async getSlackUser() { return null; }
  async findSlackUserByHandle() { return null; }
  async searchSlackUsers() { return []; }
  async roster() { return this.o.roster ?? [{ id: HELPER, handle: "h-one", name: "Helper One", role: "helper" as const }, { id: HELPER2, handle: "h-two", name: "Helper Two", role: "helper" as const }, { id: ADMIN, handle: "a-one", name: "Admin One", role: "organizer" as const }]; }
  async searchTickets(q: TicketSearch): Promise<TicketPage> {
    this.calls.push(q);
    let base = this.rows;
    if (this.o.shuffleTies) {
      // a different (but valid) order of equal timestamps on every call, as SQLite may do with OFFSET paging
      this.flip = !this.flip;
      base = [...this.rows].sort((a, b) => (this.flip ? a.id - b.id : b.id - a.id));
    }
    return coreSearch(base, q);
  }
  async ticketDetail(id: number): Promise<TicketDetail | null> {
    const d = this.o.details?.get(id);
    if (d) return d;
    const t = this.rows.find(r => r.id === id);
    return t ? { ticket: t, events: [], notes: [], eventsTruncated: false } : null;
  }
  async waitEstimate(): Promise<WaitEstimate> { return { available: false, reason: "insufficient history", sampleSize: 0 }; }
  async program(): Promise<ProgramConfig> {
    return { id: "loadout", name: "Loadout", status: "live", posture: "active", ticketVisibility: "thread", publicTicketsEnabled: true, channels: ["C0TESTHLP"], organizerChannel: null, autoAssign: false, sla: null, retentionDays: 180, ...this.o.program };
  }
  async usersInfo(ids: string[]): Promise<Record<string, SlackUserInfo | null>> {
    return Object.fromEntries(ids.map(id => [id, { slackId: id, displayName: `Name ${id.slice(-3)}`, realName: null, username: `user-${id.slice(-3).toLowerCase()}`, avatarUrl: null }]));
  }
  async closings(): Promise<ClosingInfo[] | null> { return this.o.closings ?? null; }
}
