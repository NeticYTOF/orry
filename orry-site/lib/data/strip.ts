/* Server-side stripping of text from event details (PLAN 2.4 rule 18) and of every text field from ticket rows. */
import type { EventDetail, FinishedByLabel, TicketEvent, TicketMeta, TicketRow } from "./types";
import { rowLabel, unclassified } from "../metrics/finishedBy";
import { looksSensitive } from "./sensitive";

/** Keys kept from an event's `detail`. Everything else (text, reason, summary, ts, notes) is dropped. */
const KEEP: Record<string, "string" | "number" | "boolean" | "ids" | "idOrNull"> = {
  by: "string", to: "string", automatic: "boolean", source: "string", rule: "string", verdict: "string",
  confidence: "number", via: "string", of: "number", until: "number", suggested: "ids", macro: "string"
};
const SHORT = /^[a-z0-9_.:\- ]{1,40}$/i;
const SLACK_ID = /^[UW][A-Z0-9]{2,20}$/;

export function stripDetail(raw: unknown): EventDetail | null {
  let d: unknown = raw;
  if (typeof raw === "string") { try { d = JSON.parse(raw); } catch { return null; } }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(KEEP)) {
    const v = (d as Record<string, unknown>)[k];
    if (v == null) continue;
    if (kind === "string" && typeof v === "string" && (SHORT.test(v) || SLACK_ID.test(v))) {
      // "to" must be an ID; short labels only for the rest
      if (k === "to" && !SLACK_ID.test(v)) continue;
      out[k] = v;
    } else if (kind === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (kind === "boolean" && typeof v === "boolean") out[k] = v;
    else if (kind === "ids" && Array.isArray(v)) out[k] = v.filter(x => typeof x === "string" && SLACK_ID.test(x)).slice(0, 5);
  }
  // Core's macro_sent event stores the trigger word as `trigger` (lib/macros.ts: { macroId, trigger }), e.g. "?wrapup"
  const trig = (d as Record<string, unknown>).trigger;
  if (out.macro === undefined && typeof trig === "string" && /^[?!]?[a-z0-9_\-]{1,30}$/i.test(trig)) out.macro = trig;
  return Object.keys(out).length ? (out as EventDetail) : null;
}

export function stripEvent(e: { id: number; ticket_id: number; actor_id: string | null; event_type: string; detail: unknown; created_at: number }): TicketEvent {
  return { id: e.id, ticket_id: e.ticket_id, actor_id: e.actor_id, event_type: e.event_type, detail: stripDetail(e.detail), created_at: e.created_at };
}

/** Drops question, summary and resolution text; keeps the finished-by row label and the sensitive flag. */
export function toMeta(r: TicketRow, programChannels: readonly string[] = []): TicketMeta {
  const { question, summary, resolution, ...rest } = r;
  void summary;
  const label: FinishedByLabel | null = rowLabel(r);
  void resolution;
  return {
    ...rest,
    rowLabel: label,
    sensitive: looksSensitive(question),
    outsideChannels: isOutsideChannels(r.channel, programChannels),
    unclassified: unclassified(r)
  };
}

/** A DM (D…) or a channel that is not one of the program's channels (PLAN 2.4 rule 16). Empty list = unknown, not outside. */
export function isOutsideChannels(channel: string | null | undefined, programChannels: readonly string[]): boolean {
  if (!channel) return true;
  if (channel.startsWith("D")) return true;
  return programChannels.length > 0 && !programChannels.includes(channel);
}
