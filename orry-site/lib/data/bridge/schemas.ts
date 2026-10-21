/* One zod schema per bridge route (PLAN 6.2). A response that does not match becomes a "shape" error for that panel,
   never a wrong number. Unknown keys are dropped by z.object, so text-bearing fields the site does not use never pass. */
import { z } from "zod";
import type { ProgramConfig, TicketRow, TicketStatus, TicketVisibility } from "../types";

const nn = z.number().nullable().optional().transform(v => (typeof v === "number" && Number.isFinite(v) ? v : null));
const ns = z.string().nullable().optional().transform(v => v ?? null);
const vis = z.enum(["thread", "organizer", "dashboard"]).nullable().optional().transform(v => (v ?? null) as TicketVisibility | null);

export const TicketRowSchema = z.object({
  id: z.number().int().positive(),
  program_id: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
  card_ts: ns,
  requester_id: z.string(),
  question: z.string(),
  status: z.string().min(1).max(40).transform(s => s as TicketStatus),
  assignee_id: ns,
  resolution: ns,
  created_at: z.number(),
  claimed_at: nn,
  resolved_at: nn,
  category: ns,
  summary: ns,
  first_response_at: nn,
  first_human_response_at: nn,
  visibility: vis,
  assigned_at: nn,
  reopened_at: nn,
  reopen_count: z.number().nullable().optional().transform(v => v ?? 0),
  snoozed_until: nn,
  updated_at: nn,
  public_ack_ts: ns,
  resolved_by: ns,
  resolved_credit_id: ns,
  reopened_by: ns,
  duplicate_of: nn,
  first_responder_id: ns,
  notes_count: z.number().nullable().optional().transform(v => v ?? 0),
  last_human_reply_at: nn,
  text_redacted_at: nn,
  text_redaction: z.enum(["deleted", "edited"]).nullable().optional().transform(v => v ?? null)
}).transform(r => r as TicketRow);

export const SearchSchema = z.object({ total: z.number().int().nonnegative(), rows: z.array(TicketRowSchema) });

export const EventSchema = z.object({
  id: z.number(), ticket_id: z.number(), actor_id: ns, event_type: z.string().max(60), detail: z.unknown().optional(), created_at: z.number()
});
export const NoteSchema = z.object({ id: z.number(), author_id: z.string(), body: z.string(), created_at: z.number() });
export const DetailSchema = z.object({
  ticket: TicketRowSchema,
  events: z.array(EventSchema),
  notes: z.array(NoteSchema).optional().transform(v => v ?? []),
  /* G10 (orry-bot-patched 124add3): the newest events, oldest-first within the page, with paging facts */
  eventsHasOlder: z.boolean().optional(),
  eventsTotal: z.number().int().nonnegative().optional(),
  eventsOffset: z.number().int().nonnegative().optional(),
  eventsLimit: z.number().int().positive().optional()
});

export const WaitSchema = z.union([
  z.object({ available: z.literal(true), medianWaitMs: z.number(), sampleSize: z.number(), windowDays: z.number().optional() }),
  z.object({ available: z.literal(false), reason: z.string().optional(), sampleSize: z.number().optional() })
]);

export const HealthSchema = z.object({ ok: z.boolean(), time: z.number().optional() });

export const AccessSchema = z.object({ admin: z.boolean(), helper: z.boolean() });

export const HelpersSchema = z.array(z.object({
  user_id: z.string(), role: z.string().optional().default("helper"), active: z.union([z.number(), z.boolean()]).optional().default(1)
}));

export const UsersInfoSchema = z.object({
  users: z.record(z.string(), z.object({
    slackId: z.string(), displayName: ns, realName: ns, username: ns, avatarUrl: ns
  }).nullable())
});

/** orry-bot-patched 8277083: people in one of the program's channels (the organizer channel by default). */
export const MembersSchema = z.object({
  channel: z.string().optional(),
  members: z.array(z.object({ id: z.string(), handle: ns, realName: ns, displayName: ns })),
  truncated: z.boolean().optional(),
  unresolved: z.number().optional()
});

export const ClosingSchema = z.object({
  total: z.number(),
  rows: z.array(z.object({
    id: z.number(),
    status: z.string(),
    closing: z.object({
      event: z.enum(["resolved", "closed"]),
      at: z.number(),
      actorKind: z.enum(["orry", "requester", "helper", "other"]),
      actorId: ns,
      source: ns, rule: ns, verdict: ns, confidence: nn
    }).nullable()
  }))
});

/** The global programs route returns every program. Only Loadout's entry is parsed; the rest is dropped unread. */
export const ProgramsSchema = z.array(z.record(z.string(), z.unknown()));

const ProgramEntry = z.object({
  id: z.literal("loadout"),
  name: z.string().optional().default("Loadout"),
  status: z.string().nullable().optional(),
  posture: z.string().nullable().optional(),
  ticketVisibility: vis,
  publicTicketsEnabled: z.boolean().nullable().optional(),
  channels: z.array(z.string()).optional(),
  helpChannel: z.string().nullable().optional(),
  organizerChannel: z.string().nullable().optional(),
  organizer_channel: z.string().nullable().optional(),
  organizer_channel_id: z.string().nullable().optional(),
  autoAssign: z.boolean().nullable().optional(),
  sla: z.object({ unassignedMs: nn, assignedMs: nn, waitingMs: nn }).nullable().optional(),
  retention: z.object({ ticketsDays: nn }).nullable().optional()
});

export function parseLoadout(all: Array<Record<string, unknown>>): ProgramConfig | null {
  const raw = all.find(p => p && p.id === "loadout");
  if (!raw) return null;
  const p = ProgramEntry.parse(raw);
  const sla = p.sla && (p.sla.unassignedMs || p.sla.assignedMs || p.sla.waitingMs) ? p.sla : null;
  const channels = [...new Set([...(p.channels ?? []), ...(p.helpChannel ? [p.helpChannel] : [])])];
  return {
    id: "loadout", name: p.name, status: p.status ?? null, posture: p.posture ?? null,
    ticketVisibility: p.ticketVisibility ?? null, publicTicketsEnabled: p.publicTicketsEnabled ?? null,
    channels, organizerChannel: p.organizerChannel ?? p.organizer_channel ?? p.organizer_channel_id ?? null,
    autoAssign: p.autoAssign ?? null, sla, retentionDays: p.retention?.ticketsDays ?? null
  };
}
