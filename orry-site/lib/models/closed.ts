/* getClosedModel: the closed tickets ledger (PLAN 4.4, 4.17; mockup closed.html). Every finished ticket names who
   finished it. Counts on the filter buttons match the Statistics page. Requester names are not shown here. */
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource, FinishedByLabel, TicketMeta } from "../data/types";
import { readHistoryTexts } from "../data/reads";
import { slackThreadUrl } from "../data/clock";
import { creditedHelper, isOrry } from "../metrics/finishedBy";
import { dayTime, formatDuration } from "../metrics/time";
import { labelOf } from "../metrics/week";
import { resolvePeople, personRef, type PersonRef } from "../people";
import { SENSITIVE_BOARD_COPY } from "../data/sensitive";
import { loadHistoryCtx, rowsOf } from "./history";
import { weekHeader, type WeekHeader } from "./stats";
import { categoryLabel, pctText, type Freshness, type PanelError } from "./shared";
import { excerpt, mentionIds, slackToPlain } from "./text";

export type ClosedBy = "orry" | "helper" | "participant" | "person";
export type ClosedQuery = { week?: string | null; by?: ClosedBy | "all" | null; who?: string | null; outcome?: "res" | "no" | null; includeImported?: boolean };

export type ClosedRow = {
  id: number;
  href: string;
  slackUrl: string | null;
  question: string | null;          // null when withheld; see questionNote
  questionNote: string | null;      // "Sensitive message hidden. Open the ticket to reveal it (logged)."
  category: string;
  categoryLabel: string;
  group: ClosedBy;
  label: FinishedByLabel;
  /** ORRY chip with a small line, a person with name and @username, or "Participant". */
  closedBy:
    | { kind: "orry"; rule: "last-word rule" | "judge" | "history import" }
    | { kind: "helper"; person: PersonRef }
    | { kind: "participant"; text: "Participant"; sub: "closed their own ticket" }
    | { kind: "person"; person: PersonRef | null; sub: string };   // "closed by hand", "macro: duplicate", "closed by a person or a macro"
  closedAt: string;                 // ISO
  closedText: string;               // "Sun 18 Oct 16:40" (UTC)
  took: { kind: "time"; text: string } | { kind: "no_answer" } | { kind: "no_resolution" };
  firstReplyText: string | null;    // "18 min"
  reopenCount: number;
  owner: PersonRef | null;
  credited: PersonRef | null;
  resolved: boolean;                // false = closed without resolution
  probableImport: boolean;          // visibility dashboard
};

export type ClosedModel = {
  freshness: Freshness;
  error: PanelError | null;
  week: WeekHeader;
  title: string;                    // "Closed tickets: 47 closed in week 42"
  counts: { all: number; orry: number; helper: number; participant: number; person: number };
  shares: { orry: string; helper: string; participant: string; person: string };   // "36 % of 47"
  filters: { by: ClosedBy | "all"; who: string | null; outcome: "res" | "no" | null };
  people: Array<{ id: string; person: PersonRef }>;     // options for the Person filter
  rows: ClosedRow[];                // newest first, after the query's filters
  total: number;                    // rows before filters
  result: string;                   // "47 of 47 closed tickets · week 42, UTC"
  empty: string | null;             // "Nothing finished in week 42."
  notes: string[];
  csvAllowed: boolean;              // organizers: week-level numbers only
};

const groupOf = (l: FinishedByLabel): ClosedBy => (isOrry(l) ? "orry" : l === "helper" ? "helper" : l === "participant" ? "participant" : "person");

export async function getClosedModel(s: Session, q: ClosedQuery = {}, dsIn?: DataSource): Promise<ClosedModel> {
  const ds = dsIn ?? getDataSource();
  const r = await loadHistoryCtx(ds, s.role, q.week, !!q.includeImported);
  const filters = { by: (q.by && ["orry", "helper", "participant", "person"].includes(q.by) ? q.by : "all") as ClosedBy | "all", who: q.who ?? null, outcome: q.outcome === "res" || q.outcome === "no" ? q.outcome : null };
  if (!r.ok) {
    return { freshness: r.freshness, error: r.error, week: weekHeader(r.week, r.now, r.week.key), title: `Closed tickets, week ${r.week.week}`, counts: { all: 0, orry: 0, helper: 0, participant: 0, person: 0 }, shares: { orry: "", helper: "", participant: "", person: "" }, filters, people: [], rows: [], total: 0, result: "", empty: null, notes: [], csvAllowed: s.role === "organizer" };
  }
  const v = r.v;
  const w = v.week;
  const { finished } = rowsOf(v, w);
  const texts = await readHistoryTexts(ds, v.weeks[0].start, w.end).catch(() => new Map<number, string>());

  const ids = new Set<string>([s.slackId]);
  for (const t of finished) {
    for (const x of [t.assignee_id, t.resolved_credit_id, t.resolved_by]) if (x && v.roster.ids.has(x)) ids.add(x);
    const c = v.h.closings?.get(t.id);
    if (c?.actorId) ids.add(c.actorId);
    for (const m of mentionIds(texts.get(t.id) ?? "")) ids.add(m);
  }
  const people = await resolvePeople(ids, { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (id: string | null | undefined) => (id ? people.get(id) ?? personRef(id, null, s.slackId) : null);

  const build = (t: TicketMeta): ClosedRow => {
    const label = labelOf(t, v.ctx) ?? "person_or_macro";
    const group = groupOf(label);
    const c = v.h.closings?.get(t.id);
    const credited = P(creditedHelper(t, label, v.ctx.roster));
    let closedBy: ClosedRow["closedBy"];
    if (group === "orry") closedBy = { kind: "orry", rule: label === "orry_last_word" ? "last-word rule" : label === "orry_judge" ? "judge" : "history import" };
    else if (group === "helper") closedBy = { kind: "helper", person: credited ?? P(t.resolved_by) ?? personRef("unknown", null) };
    else if (group === "participant") closedBy = { kind: "participant", text: "Participant", sub: "closed their own ticket" };
    else closedBy = { kind: "person", person: P(c?.actorId), sub: c ? (c.eventType === null ? (c.macro ? `macro: ${c.macro}` : "macro") : "closed by hand") : "closed by a person or a macro" };
    const raw = texts.get(t.id);
    let question: string | null = null, questionNote: string | null = null;
    if (t.outsideChannels) questionNote = "Outside Loadout's channels. The text is not shown.";
    else if (t.text_redacted_at) questionNote = "The participant deleted or edited this message in Slack.";
    else if (t.sensitive) questionNote = "Sensitive message hidden. Open the ticket to reveal it (logged).";
    else if (raw == null || raw === "") questionNote = raw === "" ? "No text stored." : "Text not loaded. Refresh to see it.";
    else question = excerpt(slackToPlain(raw, people));
    if (questionNote === SENSITIVE_BOARD_COPY) questionNote = "Sensitive message hidden. Open the ticket to reveal it (logged).";
    const resolved = t.status === "resolved";
    const took: ClosedRow["took"] = label === "import_closed" ? { kind: "no_answer" } : !resolved ? { kind: "no_resolution" } : { kind: "time", text: formatDuration(t.resolved_at! - t.created_at) };
    return {
      id: t.id, href: `/tickets/${t.id}`, slackUrl: t.outsideChannels ? null : slackThreadUrl(t.channel, t.thread_ts),
      question, questionNote, category: t.category ?? "other", categoryLabel: categoryLabel(t.category),
      group, label, closedBy, closedAt: new Date(t.resolved_at!).toISOString(), closedText: dayTime(t.resolved_at!),
      took, firstReplyText: t.first_human_response_at != null ? formatDuration(t.first_human_response_at - t.created_at) : null,
      reopenCount: t.reopen_count, owner: P(t.assignee_id), credited, resolved, probableImport: t.visibility === "dashboard"
    };
  };

  const visible = finished.filter(t => s.role === "organizer" || !t.outsideChannels);
  const all = visible.map(build).sort((a, b) => b.closedAt.localeCompare(a.closedAt) || b.id - a.id);
  const counts = { all: all.length, orry: 0, helper: 0, participant: 0, person: 0 };
  for (const row of all) counts[row.group]++;
  const share = (n: number) => `${pctText(all.length ? Math.round((n / all.length) * 100) : null)} of ${all.length}`;
  const rows = all.filter(row =>
    (filters.by === "all" || row.group === filters.by) &&
    (!filters.who || row.credited?.id === filters.who || (row.closedBy.kind === "person" && row.closedBy.person?.id === filters.who)) &&
    (!filters.outcome || (filters.outcome === "res" ? row.resolved : !row.resolved)));
  const personIds = [...new Set([...v.roster.helpers, ...v.roster.organizers])].filter(id => all.some(r => r.credited?.id === id || (r.closedBy.kind === "person" && r.closedBy.person?.id === id)));
  return {
    freshness: v.freshness, error: null, week: weekHeader(w, v.now, v.currentWeek),
    title: `Closed tickets: ${all.length} closed in week ${w.week}`,
    counts, shares: { orry: share(counts.orry), helper: share(counts.helper), participant: share(counts.participant), person: share(counts.person) },
    filters, people: personIds.map(id => ({ id, person: P(id)! })).sort((a, b) => a.person.label.localeCompare(b.person.label)),
    rows, total: all.length,
    result: `${rows.length} of ${all.length} closed tickets · week ${w.week}, UTC`,
    empty: all.length === 0 ? `Nothing finished in week ${w.week}.` : rows.length === 0 ? "No closed tickets match. Clear a filter to see more." : null,
    notes: [
      "Orry changed the ticket itself when the name is ORRY. The line under it says which rule: the last-word rule (a helper answered last and nobody came back for 2 days), the judge, or the history import.",
      "A named person is the helper credited with the ticket.",
      "\"Closed by Orry\" is not \"solved by Orry\". Orry does not record its own answers yet."
    ],
    csvAllowed: s.role === "organizer"
  };
}
