/* "Closed by Orry" and "who finished it" (PLAN 5.3, K17; names and credit in 4.17). Pure.
   The phase 1 rule reads the row's `resolution` prefix: the resolve call writes the event and the row together,
   and a reopen sets `resolution` back to NULL, so the row always describes the latest close.
   Prefixes verified against the bot at commit 696d203 (BOT_COMMIT below; a test pins it). */
import type { ClosingInfo, FinishedByLabel, TicketMeta, TicketRow } from "../data/types";

export const BOT_COMMIT = "696d203";

export const PREFIX = {
  lastWord: "resolved: a helper had the last word",           // lib/resolutionWatcher.ts:278, ticketBackfill.ts:421
  judge: "auto-resolved:",                                     // lib/resolutionWatcher.ts:330
  importResolved: "resolved from historical confirmation",     // lib/ticketBackfill.ts:437
  importClosed: "no answer (history import)",                  // lib/ticketBackfill.ts:384
  macro: "resolved via macro"                                  // lib/macros.ts:371 (a helper resolve)
} as const;

export const ORRY_LABELS: readonly FinishedByLabel[] = ["orry_last_word", "orry_judge", "import_resolved", "import_closed"];
export const isOrry = (l: FinishedByLabel | null): boolean => l != null && ORRY_LABELS.includes(l);
export const isImportClose = (l: FinishedByLabel | null): boolean => l === "import_resolved" || l === "import_closed";

/** Plain-language part names, in the fixed chart order (PLAN 4.3 section 2). */
export const LABEL_NAME: Record<FinishedByLabel, string> = {
  helper: "Helper",
  participant: "Participant (self-resolved)",
  orry_last_word: "Orry, last-word rule",
  orry_judge: "Orry, judge",
  import_resolved: "History import, resolved",
  import_closed: "Closed, history import, no answer",
  person_or_macro: "Closed by a person or a macro"
};
export const LABEL_ORDER: readonly FinishedByLabel[] = ["helper", "participant", "orry_last_word", "orry_judge", "import_resolved", "import_closed", "person_or_macro"];

/**
 * The phase 1 row rule (PLAN 5.3 table, middle column). Never uses `resolved_by` as "who closed it": it holds the
 * credited helper on auto-resolves. Rows that are not finished get null.
 */
export function rowLabel(t: Pick<TicketRow, "status" | "resolution" | "resolved_by" | "requester_id">): FinishedByLabel | null {
  const res = t.resolution ?? "";
  if (t.status === "closed") return res.startsWith(PREFIX.importClosed) ? "import_closed" : "person_or_macro";
  if (t.status !== "resolved") return null;
  if (res.startsWith(PREFIX.lastWord)) return "orry_last_word";
  if (res.startsWith(PREFIX.judge)) return "orry_judge";
  if (res.startsWith(PREFIX.importResolved)) return "import_resolved";
  if (t.resolved_by && t.resolved_by === t.requester_id) return "participant";
  return "helper";
}

/** True when a finished row's `resolution` matches none of the known prefixes (the Status page's drift canary). */
export function unclassified(t: Pick<TicketRow, "status" | "resolution" | "resolved_by" | "requester_id">): boolean {
  if (t.status !== "resolved" && t.status !== "closed") return false;
  const res = t.resolution ?? "";
  if (!res) return t.status === "resolved"; // a closed row with no text is a macro or hand close
  return ![PREFIX.lastWord, PREFIX.judge, PREFIX.importResolved, PREFIX.importClosed, PREFIX.macro, "resolved by <@", "resolved"].some(p => res.startsWith(p));
}

/**
 * The exact rule from the latest closing event (G9, phase 2), when the route supplies it.
 * `roster` = Slack IDs of roster helpers and admins.
 */
export function eventLabel(c: ClosingInfo, t: Pick<TicketMeta, "status" | "requester_id">, roster: ReadonlySet<string>): FinishedByLabel | null {
  if (c.eventType === null) return "person_or_macro"; // macro close writes no event
  const kind = c.actorKind ?? (c.actorId === null ? "orry" : c.actorId === t.requester_id ? "requester" : roster.has(c.actorId) ? "helper" : "other");
  if (kind === "orry") {
    if (c.source === "backfill") return t.status === "closed" ? "import_closed" : "import_resolved"; // import last-word and judge closes are history import too
    if (c.rule === "last_word") return "orry_last_word";
    if (c.verdict) return "orry_judge";
    return null; // an Orry close the rules do not name: fall back to the row rule
  }
  if (kind === "requester") return c.eventType === "resolved" ? "participant" : "person_or_macro";
  if (c.eventType === "closed") return "person_or_macro";
  return kind === "helper" ? "helper" : "person_or_macro";
}

/**
 * The person a finished ticket counts for (K26): `resolved_credit_id`, then `assignee_id`, then `resolved_by`,
 * restricted to roster members. Only "helper" finishes count for anyone (4.17 rule 3).
 */
export function creditedHelper(t: Pick<TicketMeta, "resolved_credit_id" | "assignee_id" | "resolved_by">, label: FinishedByLabel | null, roster: ReadonlySet<string>): string | null {
  if (label !== "helper") return null;
  for (const id of [t.resolved_credit_id, t.assignee_id, t.resolved_by]) if (id && roster.has(id)) return id;
  return null;
}

/** The label to use for a finished ticket: the exact one when G9 supplied it, else the row rule. */
export function finishedLabel(t: TicketMeta, closing: ClosingInfo | undefined, roster: ReadonlySet<string>): FinishedByLabel | null {
  if (t.status !== "resolved" && t.status !== "closed") return null;
  return (closing ? eventLabel(closing, t, roster) : null) ?? t.rowLabel;
}
