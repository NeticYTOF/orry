/* Builds one invented ticket row and its events the way the bot writes them (lib/db.ts:1386-1446, lib/tickets.ts).
   Field effects mirror the bot: claim sets claimed_at and assigned_at; release (unclaim) sets status open, clears the
   owner and claimed_at but keeps assigned_at; resolve may be backdated (resolved_at) while updated_at is the write time;
   reopen clears resolution, resolved_at and resolved_by but keeps the assignee and first_human_response_at. */
import type { ClosingInfo, TicketNote, TicketRow, TicketStatus, TicketVisibility } from "../types";

export type RawEvent = {
  id: number; ticket_id: number; actor_id: string | null; event_type: string;
  detail: Record<string, unknown> | null; created_at: number;
};

let eventSeq = 1;
let noteSeq = 1;
export function resetSeqs(): void { eventSeq = 1; noteSeq = 1; }

const SEC = 1000, MIN = 60 * SEC;

export class TicketBuilder {
  row: TicketRow;
  events: RawEvent[] = [];
  notes: TicketNote[] = [];
  closing: ClosingInfo | null = null;

  constructor(o: { id: number; created: number; category: string; question: string; requester: string; channel: string; visibility?: TicketVisibility }) {
    const ts = `${Math.floor(o.created / 1000)}.${String(o.id * 37 % 1000000).padStart(6, "0")}`;
    this.row = {
      id: o.id, program_id: "loadout", channel: o.channel, thread_ts: ts, card_ts: null,
      requester_id: o.requester, question: o.question, status: "open", assignee_id: null, resolution: null,
      created_at: o.created, claimed_at: null, resolved_at: null, category: o.category, summary: null,
      first_response_at: null, first_human_response_at: null, visibility: o.visibility ?? "thread",
      assigned_at: null, reopened_at: null, reopen_count: 0, snoozed_until: null, updated_at: o.created,
      public_ack_ts: null, resolved_by: null, resolved_credit_id: null, reopened_by: null, duplicate_of: null,
      first_responder_id: null, notes_count: 0
    };
    this.ev(o.requester, "created", { channel: o.channel }, o.created);
  }

  private ev(actor: string | null, type: string, detail: Record<string, unknown> | null, at: number): void {
    this.events.push({ id: eventSeq++, ticket_id: this.row.id, actor_id: actor, event_type: type, detail, created_at: Math.round(at) });
  }
  private write(at: number): void { this.row.updated_at = Math.max(this.row.updated_at ?? 0, Math.round(at)); }

  /** Orry's status message in the thread. It stamps first_response_at (never a human reply, PLAN 5.1). */
  ack(at = this.row.created_at + 30 * SEC): this {
    this.row.first_response_at ??= Math.round(at);
    this.row.public_ack_ts = `${Math.floor(at / 1000)}.000100`;
    return this;
  }
  escalate(at: number, suggested: string[] = []): this {
    this.row.status = "waiting_for_helper";
    this.ev(null, "escalated", { by: "ai_no_answer" }, at);
    if (suggested.length) this.ev(null, "helper_routing_recommended", { suggested, mode: "shadow" }, at);
    this.write(at);
    return this;
  }
  escalateByHelper(by: string, at: number): this {
    this.row.status = "escalated";
    this.ev(by, "escalated", null, at);
    this.write(at);
    return this;
  }
  autoAssign(to: string, at: number): this {
    this.row.status = "assigned"; this.row.assignee_id = to; this.row.assigned_at = Math.round(at);
    this.ev(null, "assigned", { to, automatic: true }, at);
    this.write(at);
    return this;
  }
  claim(by: string, at: number): this {
    this.row.status = "claimed"; this.row.assignee_id = by; this.row.claimed_at = Math.round(at); this.row.assigned_at = Math.round(at);
    this.ev(by, "claimed", null, at);
    this.write(at);
    return this;
  }
  assign(by: string, to: string, at: number): this {
    this.row.status = "assigned"; this.row.assignee_id = to; this.row.assigned_at = Math.round(at);
    this.ev(by, "assigned", { to }, at);
    this.write(at);
    return this;
  }
  /** Release back to the queue: lib/db.ts unclaimTicket. assigned_at stays. */
  release(by: string, at: number): this {
    this.row.status = "open"; this.row.assignee_id = null; this.row.claimed_at = null;
    this.ev(by, "unclaimed", null, at);
    this.write(at);
    return this;
  }
  decline(by: string, at: number, reason: string): this {
    this.ev(by, "assignment_declined", { reason }, at);
    return this;
  }
  reply(by: string, at: number, text?: string): this {
    if (this.row.first_human_response_at == null) { this.row.first_human_response_at = Math.round(at); this.row.first_responder_id = by; }
    this.ev(by, "helper_reply", text ? { via: "dashboard", ts: `${Math.floor(at / 1000)}.000200`, text } : { via: "thread" }, at);
    return this;
  }
  followup(at: number, text: string): this {
    this.ev(this.row.requester_id, "requester_followup", { text }, at);
    return this;
  }
  note(by: string, at: number, body: string): this {
    const id = noteSeq++;
    this.notes.push({ id, author_id: by, body, created_at: Math.round(at) });
    this.row.notes_count = this.notes.length;
    this.ev(by, "note_added", { noteId: id }, at);
    return this;
  }
  /** db.resolveTicket + recordTransition(..., resolvedAt): the event carries the backdated time; updated_at is the write time. */
  resolve(o: { at: number; actor: string | null; credit: string | null; resolution: string; detail?: Record<string, unknown> | null; writtenAt?: number }): this {
    const r = this.row;
    r.status = "resolved"; r.resolution = o.resolution; r.resolved_at = Math.round(o.at);
    r.resolved_by = o.actor ?? o.credit; r.resolved_credit_id = o.credit;
    r.first_response_at ??= Math.round(o.at);
    this.ev(o.actor, "resolved", o.detail ?? null, o.at);
    this.write(o.writtenAt ?? o.at + 2 * SEC);
    this.closing = {
      ticketId: r.id, eventType: "resolved", actorKind: o.actor == null ? "orry" : o.actor === r.requester_id ? "requester" : "helper", actorId: o.actor === r.requester_id ? null : o.actor,
      source: (o.detail?.source as string | undefined) ?? null, rule: (o.detail?.rule as string | undefined) ?? null,
      verdict: (o.detail?.verdict as string | undefined) ?? null, confidence: (o.detail?.confidence as number | undefined) ?? null, macro: null
    };
    return this;
  }
  /** db.closeTicket. A macro close writes no event (lib/macros.ts:376-377). */
  close(o: { at: number; actor: string | null; resolution?: string | null; detail?: Record<string, unknown> | null; noEvent?: boolean; macro?: string; writtenAt?: number }): this {
    const r = this.row;
    r.status = "closed"; r.resolved_at = Math.round(o.at);
    if (o.resolution) r.resolution = o.resolution;
    if (!o.noEvent) this.ev(o.actor, "closed", o.detail ?? null, o.at);
    if (o.macro) this.ev(o.actor, "macro_sent", { macro: o.macro }, o.at);
    this.write(o.writtenAt ?? o.at + 2 * SEC);
    this.closing = {
      ticketId: r.id, eventType: o.noEvent ? null : "closed", actorKind: o.noEvent ? null : o.actor == null ? "orry" : "helper", actorId: o.noEvent ? null : o.actor,
      source: (o.detail?.source as string | undefined) ?? null, rule: null, verdict: null, confidence: null, macro: o.macro ?? null
    };
    return this;
  }
  reopen(at: number, by: string): this {
    const r = this.row;
    r.status = "reopened"; r.resolution = null; r.resolved_at = null; r.resolved_by = null;
    r.reopened_by = by; r.reopened_at = Math.round(at); r.reopen_count += 1;
    this.ev(by, "reopened", { by: by === r.requester_id ? "requester" : "helper" }, at);
    this.write(at);
    this.closing = null;
    return this;
  }
  snooze(by: string, at: number, until: number): this {
    this.row.status = "snoozed"; this.row.snoozed_until = Math.round(until);
    this.ev(by, "snoozed", { until: Math.round(until) }, at);
    this.write(at);
    return this;
  }
  duplicate(by: string, at: number, of: number): this {
    this.row.status = "duplicate"; this.row.duplicate_of = of;
    this.ev(by, "duplicate", { of }, at);
    this.write(at);
    return this;
  }
  setStatus(s: TicketStatus): this { this.row.status = s; return this; }
}

export { MIN, SEC };
