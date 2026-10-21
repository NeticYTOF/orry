/* Statistics per ISO week in UTC (PLAN 4.3, 5.3, 5.4). Pure functions over text-free ticket rows.
   Two groups of tickets, never mixed: "created this week" (created_at in the week) and "finished this week"
   (resolved_at in the week, status resolved or closed). Finished = resolved + closed. */
import type { ClosingInfo, FinishedByLabel, TicketMeta } from "../data/types";
import { NEEDS_HUMAN_STATUSES } from "../data/types";
import { creditedHelper, finishedLabel, LABEL_ORDER } from "./finishedBy";
import { MIN_N, summary, upperMedian, type Summary } from "./stats";
import { HOUR, utcWeekday, type WeekRange } from "./time";

export type StatsContext = {
  now: number;
  limitMs: number;
  roster: ReadonlySet<string>;
  includeImported: boolean;
  closings?: ReadonlyMap<number, ClosingInfo> | null;
  /** false when every ticket is dashboard-visible (the program setting): nothing is treated as imported */
  importDetection?: boolean;
};

export const imported = (t: Pick<TicketMeta, "visibility">, ctx: Pick<StatsContext, "importDetection">): boolean => (ctx.importDetection ?? true) && t.visibility === "dashboard";
const inRange = (ms: number | null, w: Pick<WeekRange, "start" | "end">) => ms != null && ms >= w.start && ms < w.end;

export function createdIn(rows: readonly TicketMeta[], w: Pick<WeekRange, "start" | "end">, ctx: StatsContext): TicketMeta[] {
  return rows.filter(t => inRange(t.created_at, w) && (ctx.includeImported || !imported(t, ctx)));
}
export function finishedIn(rows: readonly TicketMeta[], w: Pick<WeekRange, "start" | "end">, ctx: StatsContext): TicketMeta[] {
  return rows.filter(t => (t.status === "resolved" || t.status === "closed") && inRange(t.resolved_at, w) && (ctx.includeImported || !imported(t, ctx)));
}
export const labelOf = (t: TicketMeta, ctx: StatsContext): FinishedByLabel | null => finishedLabel(t, ctx.closings?.get(t.id), ctx.roster);

/** Phase 1 stand-in for "needed a human" (PLAN 4.3 cohort table). */
export function neededHuman(t: TicketMeta): boolean {
  return t.first_human_response_at != null || t.assigned_at != null || (t.reopen_count ?? 0) > 0 || NEEDS_HUMAN_STATUSES.includes(t.status);
}
/** First human reply lag; never first_response_at (the bot's status message stamps that one). */
export const firstReplyLag = (t: TicketMeta): number | null => (t.first_human_response_at != null ? t.first_human_response_at - t.created_at : null);
export const resolutionTime = (t: TicketMeta): number | null => (t.status === "resolved" && t.resolved_at != null ? t.resolved_at - t.created_at : null);

export type WithinLimit = { within: number; of: number; stillInside: number; pct: number | null };

/** K27: needed-a-human tickets replied within L, or finished within L without a reply / those replied or older than L. */
export function withinLimit(created: readonly TicketMeta[], ctx: StatsContext): WithinLimit {
  let within = 0, of = 0, stillInside = 0;
  for (const t of created.filter(neededHuman)) {
    const lag = firstReplyLag(t);
    if (lag != null) { of++; if (lag <= ctx.limitMs) within++; continue; }
    const finishedAt = t.status === "resolved" || t.status === "closed" ? t.resolved_at : null;
    if (finishedAt != null && finishedAt - t.created_at <= ctx.limitMs) { of++; within++; continue; }
    if (finishedAt == null && ctx.now - t.created_at < ctx.limitMs) { stillInside++; continue; }
    of++;
  }
  return { within, of, stillInside, pct: of ? Math.round((within / of) * 100) : null };
}

export type LabelCounts = Record<FinishedByLabel, number>;
export const emptyLabels = (): LabelCounts => ({ helper: 0, participant: 0, orry_last_word: 0, orry_judge: 0, import_resolved: 0, import_closed: 0, person_or_macro: 0 });

export type WeekStats = {
  created: number;
  createdImported: number;          // imported tickets created in the week (always counted, for the toggle label)
  neededHuman: number;
  finished: number;
  resolved: number;
  closed: number;
  closedImportNoAnswer: number;
  closedOther: number;
  labels: LabelCounts;
  orry: { total: number; lastWord: number; judge: number; importResolved: number; importClosed: number; live: number };
  people: { total: number; helpers: number; participants: number; personOrMacro: number };
  firstReply: Summary & { withNone: number };
  resolution: Summary;
  reopened: { n: number; of: number; pct: number | null };
  within: WithinLimit;
  noHumanReply: { n: number; of: number; pct: number | null };
  credited: Map<string, number>;    // Slack ID → finished credited to them
  unclassified: number;
  sourceExact: boolean;             // true when G9 closing events decided every label
};

export function weekStats(created: readonly TicketMeta[], finished: readonly TicketMeta[], allCreatedInWeek: readonly TicketMeta[], ctx: StatsContext): WeekStats {
  const labels = emptyLabels();
  const credited = new Map<string, number>();
  let unclassified = 0, exact = true;
  for (const t of finished) {
    const l = labelOf(t, ctx);
    if (!l) continue;
    labels[l]++;
    if (!ctx.closings?.get(t.id)) exact = false;
    if (t.unclassified) unclassified++;
    const who = creditedHelper(t, l, ctx.roster);
    if (who) credited.set(who, (credited.get(who) ?? 0) + 1);
  }
  const resolved = finished.filter(t => t.status === "resolved").length;
  const closed = finished.length - resolved;
  const lags = created.map(firstReplyLag);
  const fr = summary(lags);
  const reopenedN = created.filter(t => (t.reopen_count ?? 0) > 0).length;
  const noReply = finished.filter(t => t.first_human_response_at == null).length;
  const orryTotal = labels.orry_last_word + labels.orry_judge + labels.import_resolved + labels.import_closed;
  return {
    created: created.length,
    createdImported: allCreatedInWeek.filter(t => imported(t, ctx)).length,
    neededHuman: created.filter(neededHuman).length,
    finished: finished.length, resolved, closed,
    closedImportNoAnswer: labels.import_closed, closedOther: closed - labels.import_closed,
    labels,
    orry: { total: orryTotal, lastWord: labels.orry_last_word, judge: labels.orry_judge, importResolved: labels.import_resolved, importClosed: labels.import_closed, live: labels.orry_last_word + labels.orry_judge },
    people: { total: labels.helper + labels.participant + labels.person_or_macro, helpers: labels.helper, participants: labels.participant, personOrMacro: labels.person_or_macro },
    firstReply: { ...fr, withNone: created.length - created.filter(t => t.first_human_response_at != null).length },
    resolution: summary(finished.map(resolutionTime)),
    reopened: { n: reopenedN, of: created.length, pct: created.length ? Math.round((reopenedN / created.length) * 100) : null },
    within: withinLimit(created, ctx),
    noHumanReply: { n: noReply, of: finished.length, pct: finished.length ? Math.round((noReply / finished.length) * 100) : null },
    credited, unclassified, sourceExact: exact && finished.length > 0
  };
}

/* ---------- the waiting grid: 7 UTC weekdays × 12 two-hour blocks, tickets created ---------- */

export type HeatCell = { day: number; block: number; created: number; neededHuman: number; firstReply: Summary };
export function heatmap(created: readonly TicketMeta[]): HeatCell[] {
  const cells: HeatCell[] = [];
  for (let d = 0; d < 7; d++) for (let b = 0; b < 12; b++) cells.push({ day: d, block: b, created: 0, neededHuman: 0, firstReply: summary([]) });
  const lags = new Map<number, number[]>();
  for (const t of created) {
    const d = utcWeekday(t.created_at), b = Math.floor(new Date(t.created_at).getUTCHours() / 2);
    const i = d * 12 + b;
    cells[i].created++;
    if (neededHuman(t)) {
      cells[i].neededHuman++;
      const l = firstReplyLag(t);
      if (l != null) (lags.get(i) ?? lags.set(i, []).get(i)!).push(l);
    }
  }
  for (const [i, l] of lags) cells[i].firstReply = summary(l);
  return cells;
}
/** Heat shade step 0-4 by count (stats.html: 0, 1-2, 3-4, 5-6, 7 or more). */
export const heatStep = (n: number): 0 | 1 | 2 | 3 | 4 => (n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4);

/* ---------- by category (K25) ---------- */

export type CategoryRow = {
  category: string;
  created: number;
  firstReply: Summary;             // created cohort
  resolution: Summary;             // finished cohort (this category)
  reopened: number;                // of created
  selfResolved: number;            // of created, finished by the participant
  countsOnly: boolean;             // fewer than 5 created
};
export function byCategory(created: readonly TicketMeta[], finished: readonly TicketMeta[], ctx: StatsContext): CategoryRow[] {
  const cats = [...new Set(created.map(t => t.category ?? "other"))];
  return cats.map(c => {
    const cr = created.filter(t => (t.category ?? "other") === c);
    const fi = finished.filter(t => (t.category ?? "other") === c);
    return {
      category: c,
      created: cr.length,
      firstReply: summary(cr.map(firstReplyLag)),
      resolution: summary(fi.map(resolutionTime)),
      reopened: cr.filter(t => (t.reopen_count ?? 0) > 0).length,
      selfResolved: cr.filter(t => labelOf(t, ctx) === "participant").length,
      countsOnly: cr.length < MIN_N
    };
  }).sort((a, b) => b.created - a.created || a.category.localeCompare(b.category));
}

/* ---------- per person (K26): team table, leaderboard, my stats ---------- */

export type PersonMeasures = {
  id: string;
  finished: number;                // credited helper finishes (Orry, participant and macro closes never count)
  firstReplies: number;            // created cohort, by first_responder_id
  firstReply: Summary;             // n ≥ 5 rule
  reopened: number;                // of their first replies, reopen_count > 0
};
export function personMeasures(id: string, created: readonly TicketMeta[], finished: readonly TicketMeta[], ctx: StatsContext): PersonMeasures {
  const mine = created.filter(t => t.first_responder_id === id && t.first_human_response_at != null);
  let fin = 0;
  for (const t of finished) if (creditedHelper(t, labelOf(t, ctx), ctx.roster) === id) fin++;
  return { id, finished: fin, firstReplies: mine.length, firstReply: summary(mine.map(firstReplyLag)), reopened: mine.filter(t => (t.reopen_count ?? 0) > 0).length };
}

export type TeamTotals = { finished: number; firstReplies: number; firstReplyMedian: number | null; firstReplyTooFew: boolean; reopened: number };
export function teamTotals(created: readonly TicketMeta[], finished: readonly TicketMeta[], ctx: StatsContext): TeamTotals {
  const replied = created.filter(t => t.first_human_response_at != null);
  let fin = 0;
  for (const t of finished) if (creditedHelper(t, labelOf(t, ctx), ctx.roster)) fin++;
  const s = summary(replied.map(firstReplyLag));
  return { finished: fin, firstReplies: replied.length, firstReplyMedian: s.median, firstReplyTooFew: s.tooFew, reopened: replied.filter(t => (t.reopen_count ?? 0) > 0).length };
}

/** Ranks with shared ties; null values rank last and get no rank. `better` = smaller is better. */
export function rank<T>(rows: readonly T[], value: (r: T) => number | null, better: "low" | "high", tiebreak: (a: T, b: T) => number): Array<T & { rank: number | null }> {
  const v = (r: T) => { const x = value(r); return x == null ? null : better === "low" ? x : -x; };
  const sorted = [...rows].sort((a, b) => {
    const x = v(a), y = v(b);
    if (x == null && y == null) return tiebreak(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y || tiebreak(a, b);
  });
  let r = 0, last: number | null | undefined;
  return sorted.map((row, i) => {
    const x = v(row);
    if (x !== last) { r = i + 1; last = x; }
    return { ...row, rank: x == null ? null : r };
  });
}

/** Provisional for 7 days after the week ends (auto-resolves are backdated; the last-word rule waits 2 days). */
export function provisional(w: Pick<WeekRange, "end">, now: number): { provisional: boolean; until: number } {
  const until = w.end + 7 * 24 * HOUR;
  return { provisional: now < until, until: until - 1 };
}

export { LABEL_ORDER, upperMedian };
