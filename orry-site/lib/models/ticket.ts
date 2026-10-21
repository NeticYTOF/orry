/* getTicketModel and revealTicket: the ticket page and the board's sheet (PLAN 4.2, 2.4 rules 4, 5, 16, 17).
   Sensitive question text is withheld by the server until revealTicket(), which writes the access log row first. */
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource, TicketDetail, TicketEvent, TicketRow } from "../data/types";
import { isDataError } from "../data/types";
import { readDetail, readProgram, readRoster, reopenFromEvents, staffCandidates, withOrganizers } from "../data/reads";
import { siteLimitMinutes, slackThreadUrl } from "../data/clock";
import { isOutsideChannels, toMeta } from "../data/strip";
import { looksSensitive } from "../data/sensitive";
import { hasNoOwner, humanReplySince, isReleased, limitChip, previousOwner, STATUS_WORD, waitingSince, type BoardContext } from "../metrics/board";
import { creditedHelper, eventLabel, LABEL_NAME, rowLabel } from "../metrics/finishedBy";
import { dayTime, formatDuration, hhmm, isoDuration, MIN } from "../metrics/time";
import { personRef, resolvePeople, type PersonRef } from "../people";
import { categoryLabel, freshnessOf, panelError, type Freshness, type PanelError } from "./shared";
import { mentionIds, slackToPlain } from "./text";
import { logAccess } from "./deps";

export type TicketModel = {
  id: number;
  title: string;                          // "Ticket #1042"
  href: string;
  freshness: Freshness;
  error: PanelError | null;
  status: string;                         // Orry's status, or "released"
  statusWord: string;
  limit: "over" | "near" | "unknown" | null;
  limitText: string | null;
  waitText: string | null;                // null for finished tickets
  waitIso: string | null;
  atLeast: boolean;
  category: string;
  categoryLabel: string;
  slackUrl: string | null;                // null outside the program's channels
  cardUrl: string | null;
  question: {
    state: "shown" | "withheld_sensitive" | "withheld_outside" | "redacted" | "stale" | "empty";
    /** null unless state is "shown" */
    text: string | null;
    note: string | null;                  // "Sensitive topic. The message is hidden until you choose to read it."
    requester: PersonRef | null;          // names on the ticket page only, never in lists
    where: string;                        // "in the help channel"
    at: string;                           // ISO of created_at
    copyNote: string | null;              // "Text is a copy taken at 14:02. It may have been deleted or edited in Slack."
    revealPath: string | null;            // POST here to reveal (sensitive only)
    safeguardingNote: string | null;
  };
  facts: Array<{ key: string; term: string; value: string; sub: string | null }>;
  owner: PersonRef | null;
  previousOwner: PersonRef | null;
  releasedBy: PersonRef | null;
  suggestions: { people: Array<{ person: PersonRef; reason: string }>; caption: string } | null;
  timeline: Array<{ at: string; timeUtc: string; text: string }>;
  systemEvents: Array<{ at: string; timeUtc: string; text: string }>;
  eventsNote: string | null;              // "Only the first 100 events are available. The newest may be missing."
  notes: Array<{ author: PersonRef; at: string; timeUtc: string; body: string }>;
  notesCaption: string;
  ending: { label: string; byOrry: boolean; rule: string | null; person: PersonRef | null; credited: PersonRef | null; at: string; atText: string } | null;
  threadNote: string;                     // "Orry's answer and the rest of the thread are in Slack."
};

export type RevealResult = { ok: true; text: string; shownAt: string; note: string } | { ok: false; reason: "not_found" | "not_sensitive" | "unavailable" | "forbidden" };

const SYSTEM = new Set(["resolution_judged", "macro_sent", "rivet_answer", "note_added"]);

function sentence(e: TicketEvent, t: TicketRow, P: (id: string | null | undefined) => PersonRef | null, roster: ReadonlySet<string>): string | null {
  const who = P(e.actor_id)?.label ?? "Someone";
  const d = e.detail ?? {};
  switch (e.event_type) {
    case "created": return "Ticket opened from a thread in the help channel.";
    case "escalated": return d.by === "ai_no_answer" ? "Orry escalated: no grounded answer." : e.actor_id ? `${who} escalated it to organizers.` : "Orry escalated it.";
    case "helper_routing_recommended": return `Orry suggested ${d.suggested?.length ?? "some"} helpers (shadow routing, nobody pinged).`;
    case "assigned": {
      const to = P(d.to ?? null)?.label ?? "a helper";
      if (d.automatic || !e.actor_id) return `Assigned to ${to} automatically (no ping sent).`;
      return d.to === e.actor_id ? `${who} took it.` : `${who} assigned it to ${to}.`;
    }
    case "claimed": return `${who} claimed it.`;
    case "unclaimed": return `${who} released it to the queue. Nobody owns it now.`;
    case "assignment_declined": return `${who} passed.`;
    case "helper_reply": return d.via === "dashboard" ? `Reply from ${who} via the dashboard.` : `Reply from ${who} in the thread.`;
    case "requester_followup": return "The requester followed up in the thread.";
    case "reopened": return d.by === "requester" ? "Reopened by the requester." : `Reopened by ${who}.`;
    case "resolved": {
      const l = eventLabel({ ticketId: t.id, eventType: "resolved", actorKind: null, actorId: e.actor_id, source: d.source ?? null, rule: d.rule ?? null, verdict: d.verdict ?? null, confidence: d.confidence ?? null, macro: null }, t, roster);
      if (l === "orry_last_word") return "Orry resolved it: a helper had the last word and the requester didn't come back for 2 days.";
      if (l === "orry_judge") return "Orry's judge resolved it after reading the thread.";
      if (l === "import_resolved") return "Orry's history import resolved it.";
      if (l === "participant") return "The requester resolved it.";
      return `Resolved by ${who}.`;
    }
    case "closed": return d.source === "backfill" ? "Orry's history import closed it: no answer." : e.actor_id ? `Closed by ${who}.` : "Closed by Orry.";
    case "snoozed": return `${who} parked it (snoozed). Snoozed tickets never wake up in Orry.`;
    case "duplicate": return `${who} marked it a duplicate of #${d.of ?? "?"}.`;
    case "note_added": return `${who} added a note.`;
    case "resolution_judged": return "Orry's judge checked the thread.";
    case "macro_sent": return `A macro was sent${d.macro ? ` (${d.macro})` : ""}.`;
    case "rivet_answer": return "Orry answered in the thread.";
    case "root_message_deleted": return "The participant deleted the message in Slack. Its text was removed.";
    case "root_message_edited": return "The participant edited the message in Slack. The stored text was removed.";
    default: return null;
  }
}

/** The ticket for one viewer. null = not found, another program, or (for helpers) outside the program's channels. */
export async function getTicketModel(s: Session, id: number, dsIn?: DataSource): Promise<TicketModel | null> {
  const ds = dsIn ?? getDataSource();
  if (!Number.isInteger(id) || id <= 0) return null;
  let read;
  try { read = await readDetail(ds, id); }
  catch (e) {
    return errorModel(id, freshnessOf(ds, null, isDataError(e) ? e : null), panelError(e, s.role));
  }
  const d = read.value;
  if (!d) return null;
  const t = d.ticket;
  const [programR, rosterR] = await Promise.allSettled([readProgram(ds), readRoster(ds)]);
  const program = programR.status === "fulfilled" ? programR.value.value : null;
  const rosterRead = rosterR.status === "fulfilled" ? rosterR.value.value : { ids: new Set<string>(), helpers: [], organizers: [] };
  // organizers are not on Core's helper list: ask about the people this ticket names (owner, replies, the close)
  const staffEvents = d.events.filter(e => e.event_type === "helper_reply" || e.event_type === "claimed" || e.event_type === "resolved" || e.event_type === "closed").map(e => e.actor_id);
  const roster = (await withOrganizers(ds, rosterRead, [...staffCandidates([t]), ...staffEvents.filter(x => x !== t.requester_id)])).ids;
  const outside = isOutsideChannels(t.channel, program?.channels ?? []);
  if (outside && s.role !== "organizer") return null;
  void logAccess("ticket_view", s.slackId, id).catch(() => undefined);

  const freshness = freshnessOf(ds, read);
  const now = ds.now();
  const limitMs = siteLimitMinutes() * MIN;
  const reopen = new Map(t.reopened_at != null ? [[t.id, reopenFromEvents(d, t.reopened_at, roster)]] : []);
  const ctx: BoardContext = { now, limitMs, me: s.slackId, reopen };

  const ids = new Set<string>([t.requester_id, s.slackId]);
  if (t.assignee_id) ids.add(t.assignee_id);
  if (t.first_responder_id) ids.add(t.first_responder_id);
  if (t.resolved_credit_id) ids.add(t.resolved_credit_id);
  for (const e of d.events) { if (e.actor_id) ids.add(e.actor_id); if (e.detail?.to) ids.add(e.detail.to); for (const x of e.detail?.suggested ?? []) ids.add(x); }
  for (const n of d.notes) ids.add(n.author_id);
  for (const m of mentionIds(t.question)) ids.add(m);
  const people = await resolvePeople(ids, { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (x: string | null | undefined) => (x ? people.get(x) ?? personRef(x, null, s.slackId) : null);

  const finished = t.status === "resolved" || t.status === "closed";
  const released = isReleased(t);
  const ws = waitingSince(t);
  const waitMs = finished ? null : Math.max(0, now - ws.at);
  const chip = finished ? null : limitChip(t, ctx);
  const reply = humanReplySince(t, ctx);
  const sensitive = looksSensitive(t.question);
  const copyAt = hhmm(freshness.at ? Date.parse(freshness.at) : now);

  let qState: TicketModel["question"]["state"] = "shown", qText: string | null = null, qNote: string | null = null;
  if (outside) { qState = "withheld_outside"; qNote = "This ticket is outside Loadout's channels (for example a direct message). Only organizers see it, and the text is not shown."; }
  else if (t.text_redacted_at) { qState = "redacted"; qNote = t.text_redaction === "edited" ? "The participant edited this message in Slack, so the stored copy was removed. Open it in Slack." : "The participant deleted this message in Slack. Only a tombstone is kept."; }
  else if (!t.question) { qState = "empty"; qNote = "No text stored."; }
  else if (sensitive) { qState = "withheld_sensitive"; qNote = "Sensitive topic. The message is hidden until you choose to read it."; }
  else if (freshness.hideText) { qState = "stale"; qNote = "Hidden while Orry's data is old. Open it in Slack."; }
  else qText = slackToPlain(t.question, people);

  const ownerGone = hasNoOwner(t, ctx);
  const owner = finished ? P(t.assignee_id) : ownerGone ? null : P(t.assignee_id);
  const prev = finished ? null : P(previousOwner(t, ctx));
  const lastRelease = d.events.filter(e => e.event_type === "unclaimed").at(-1);
  const releasedBy = released ? P(lastRelease?.actor_id) : null;
  const firstResponder = P(t.first_responder_id);
  const autoAssign = d.events.find(e => e.event_type === "assigned" && e.detail?.automatic);

  const facts: TicketModel["facts"] = [];
  if (waitMs != null) facts.push({ key: "waiting", term: "Waiting", value: `${ws.atLeast ? "at least " : ""}${formatDuration(waitMs)}`, sub: categoryLabel(t.category) });
  facts.push({
    key: "owner", term: "Owner",
    value: owner ? (owner.id === s.slackId ? "You" : owner.label) : prev ? `Previously ${prev.label}` : releasedBy ? `Released by ${releasedBy.label}` : "No owner",
    sub: prev ? "Nobody has been told about the reopen." : releasedBy ? "Released to the queue. Nobody owns it now." : autoAssign && owner && t.status === "assigned" ? "Assigned automatically. Orry sent no ping." : null
  });
  facts.push({
    key: "reply", term: "Human reply",
    value: t.first_human_response_at != null ? `After ${formatDuration(t.first_human_response_at - t.created_at)}${firstResponder ? `, ${firstResponder.label}` : ""}` : "None yet",
    sub: t.reopened_at != null && !finished ? (reply === true ? "A helper replied or took it since the reopen." : reply === "unknown" ? "Only the first 100 events are available, so a reply since the reopen can't be seen." : "None recorded since the reopen. A repeat reply by the same helper is not recorded, so this is not proof.") : null
  });
  facts.push({ key: "reopened", term: "Reopened", value: t.reopen_count ? `${t.reopen_count} time${t.reopen_count === 1 ? "" : "s"}${t.reopened_at ? `, last ${dayTime(t.reopened_at)} UTC` : ""}` : "Never", sub: null });
  facts.push({ key: "requester", term: "Requester", value: P(t.requester_id)?.label ?? "Unknown", sub: "Names show here only, never in the list." });
  facts.push({ key: "opened", term: "Opened", value: `${dayTime(t.created_at)} UTC`, sub: null });
  facts.push({ key: "visibility", term: "Visibility", value: t.visibility === "dashboard" ? "Import only" : t.visibility === "organizer" ? "Organizer channel" : "In the thread", sub: null });
  facts.push({ key: "ack", term: "Status message", value: t.public_ack_ts ? "Posted" : "No", sub: "Orry's own message. Not a human reply." });
  facts.push({ key: "card", term: "Organizer card", value: t.card_ts ? "Posted" : "Not posted", sub: program && !program.organizerChannel ? "Orry has no organizer channel." : null });

  const routing = d.events.find(e => e.event_type === "helper_routing_recommended");
  const suggestions = routing?.detail?.suggested?.length
    ? { people: routing.detail.suggested.map(id => ({ person: P(id)!, reason: id === t.assignee_id ? "Owns it now." : "Suggested by Orry's routing." })), caption: "Orry's routing suggestion at escalation time." }
    : null;

  const timeline: TicketModel["timeline"] = [], system: TicketModel["systemEvents"] = [];
  for (const e of d.events) {
    const text = sentence(e, t, P, roster);
    if (!text) continue;
    const item = { at: new Date(e.created_at).toISOString(), timeUtc: hhmm(e.created_at), text };
    (SYSTEM.has(e.event_type) ? system : timeline).push(item);
  }

  let ending: TicketModel["ending"] = null;
  if (finished) {
    const meta = toMeta(t, program?.channels ?? []);
    const last = [...d.events].reverse().find(e => e.event_type === "resolved" || e.event_type === "closed");
    const fromEvent = last ? eventLabel({ ticketId: t.id, eventType: last.event_type as "resolved" | "closed", actorKind: null, actorId: last.actor_id, source: last.detail?.source ?? null, rule: last.detail?.rule ?? null, verdict: last.detail?.verdict ?? null, confidence: last.detail?.confidence ?? null, macro: null }, t, roster) : t.status === "closed" ? "person_or_macro" : null;
    const label = fromEvent ?? rowLabel(t) ?? "person_or_macro";
    const byOrry = label.startsWith("orry") || label.startsWith("import");
    ending = {
      label: LABEL_NAME[label], byOrry,
      rule: label === "orry_last_word" ? "last-word rule" : label === "orry_judge" ? "judge" : label.startsWith("import") ? "history import" : null,
      person: !byOrry && label !== "participant" ? P(last?.actor_id) : null,
      credited: P(creditedHelper(meta, label, roster)),
      at: new Date(t.resolved_at ?? t.updated_at ?? t.created_at).toISOString(), atText: `${dayTime(t.resolved_at ?? t.created_at)} UTC`
    };
  }

  const statusKey = released ? "released" : t.status;
  return {
    id, title: `Ticket #${id}`, href: `/tickets/${id}`, freshness, error: null,
    status: statusKey,
    statusWord: statusKey === "reopened" && t.reopen_count > 1 ? `Reopened ×${t.reopen_count}` : STATUS_WORD[statusKey as keyof typeof STATUS_WORD] ?? t.status,
    limit: chip,
    limitText: chip === "over" ? `Over ${formatDuration(limitMs)}` : chip === "near" ? `Near ${formatDuration(limitMs * 0.75)}` : chip === "unknown" ? "Unknown: 100+ events" : null,
    waitText: waitMs != null ? formatDuration(waitMs) : null, waitIso: waitMs != null ? isoDuration(waitMs) : null, atLeast: ws.atLeast,
    category: t.category ?? "other", categoryLabel: categoryLabel(t.category),
    slackUrl: outside ? null : slackThreadUrl(t.channel, t.thread_ts),
    cardUrl: !outside && t.card_ts && program?.organizerChannel ? slackThreadUrl(program.organizerChannel, t.card_ts) : null,
    question: {
      state: qState, text: qText, note: qNote, requester: outside ? null : P(t.requester_id), where: "in the help channel", at: new Date(t.created_at).toISOString(),
      copyNote: qState === "shown" ? `Text is a copy taken at ${copyAt}. It may have been deleted or edited in Slack.` : null,
      revealPath: qState === "withheld_sensitive" ? `/api/tickets/${id}/reveal` : null,
      safeguardingNote: qState === "withheld_sensitive" ? "Showing it is written to the access log. The safeguarding contact is added by the owners before launch." : null
    },
    facts, owner, previousOwner: prev, releasedBy, suggestions, timeline, systemEvents: system,
    eventsNote: !d.eventsTruncated ? null
      : d.eventsWindow === "newest" ? `Showing the newest ${d.events.length}${d.eventsTotal ? ` of ${d.eventsTotal}` : ""} events. Older events are not shown.`
      : "Only the first 100 events are available. The newest may be missing.",
    notes: freshness.hideText ? [] : d.notes.map(n => ({ author: P(n.author_id)!, at: new Date(n.created_at).toISOString(), timeUtc: hhmm(n.created_at), body: n.body })),
    notesCaption: "Read-only on the site until phase 5.",
    ending,
    threadNote: "Orry's answer and the rest of the thread are in Slack."
  };
}

function errorModel(id: number, freshness: Freshness, error: PanelError): TicketModel {
  return {
    id, title: `Ticket #${id}`, href: `/tickets/${id}`, freshness, error, status: "unknown", statusWord: "Unknown", limit: null, limitText: null,
    waitText: null, waitIso: null, atLeast: false, category: "other", categoryLabel: "Other", slackUrl: null, cardUrl: null,
    question: { state: "empty", text: null, note: null, requester: null, where: "", at: "", copyNote: null, revealPath: null, safeguardingNote: null },
    facts: [], owner: null, previousOwner: null, releasedBy: null, suggestions: null, timeline: [], systemEvents: [], eventsNote: null, notes: [],
    notesCaption: "", ending: null, threadNote: "Orry's answer and the rest of the thread are in Slack."
  };
}

/**
 * Reveals a sensitive ticket's text to one signed-in helper or organizer. The access log row is written FIRST;
 * if that fails, nothing is returned. The caller must send the text with Cache-Control: no-store.
 */
export async function revealTicket(s: Session, id: number, dsIn?: DataSource): Promise<RevealResult> {
  const ds = dsIn ?? getDataSource();
  let d: TicketDetail | null;
  try { d = (await readDetail(ds, id)).value; } catch { return { ok: false, reason: "unavailable" }; }
  if (!d) return { ok: false, reason: "not_found" };
  const program = await readProgram(ds).then(r => r.value).catch(() => null);
  const outside = isOutsideChannels(d.ticket.channel, program?.channels ?? []);
  if (outside) return { ok: false, reason: "forbidden" };       // text is never shown for these (PLAN 2.4 rule 16)
  if (!looksSensitive(d.ticket.question) || d.ticket.text_redacted_at) return { ok: false, reason: "not_sensitive" };
  try { await logAccess("ticket_reveal", s.slackId, id); } catch { return { ok: false, reason: "unavailable" }; }
  const people = await resolvePeople(mentionIds(d.ticket.question), { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const shown = Date.now();
  return { ok: true, text: slackToPlain(d.ticket.question, people), shownAt: new Date(shown).toISOString(), note: `Shown to you at ${hhmm(shown)}. This is logged.` };
}
