/* The shared read behind Statistics, Closed tickets, My stats and the Leaderboard: 12 ISO weeks (UTC) ending at the
   chosen week, with the stats context. Only text-free rows are kept here (the ledger's question text has its own
   2-minute cache in lib/data/reads.ts). */
import type { DataSource } from "../data/types";
import { isDataError } from "../data/types";
import { readHistory, readProgram, readRoster, staffCandidates, withOrganizers, type History, type RosterInfo } from "../data/reads";
import { siteLimitMinutes } from "../data/clock";
import { lastWeeks, parseWeek, shiftWeek, weekKey, type WeekRange } from "../metrics/time";
import { createdIn, finishedIn, personMeasures, type StatsContext } from "../metrics/week";
import type { TicketMeta } from "../data/types";
import { freshnessOf, panelError, type Freshness, type PanelError } from "./shared";
import type { Role } from "../session";

export const HISTORY_WEEKS = 12;

export type HistoryCtx = {
  ds: DataSource;
  now: number;
  week: WeekRange;
  currentWeek: string;
  weeks: WeekRange[];            // oldest first, the last is `week`
  h: History;
  roster: RosterInfo;
  ctx: StatsContext;
  freshness: Freshness;
  importDetection: boolean;
};

/** A valid week key not after the current week; anything else becomes the current week. */
export function resolveWeek(raw: string | null | undefined, now: number): WeekRange {
  const cur = weekKey(now);
  const r = raw ? parseWeek(raw) : null;
  if (!r || r.start > parseWeek(cur)!.start) return parseWeek(cur)!;
  return r;
}

export async function loadHistoryCtx(ds: DataSource, role: Role, weekRaw: string | null | undefined, includeImported: boolean): Promise<{ ok: true; v: HistoryCtx } | { ok: false; freshness: Freshness; error: PanelError; week: WeekRange; now: number }> {
  const now = ds.now();
  const week = resolveWeek(weekRaw, now);
  const keys = lastWeeks(week.key, HISTORY_WEEKS);
  const weeks = keys.map(k => parseWeek(k)!);
  try {
    const [hr, rr, pr] = await Promise.all([readHistory(ds, weeks[0].start, week.end), readRoster(ds), readProgram(ds).catch(() => null)]);
    const program = pr?.value ?? null;
    const importDetection = !(program && (program.ticketVisibility === "dashboard" || program.publicTicketsEnabled === false));
    const roster = await withOrganizers(ds, rr.value, staffCandidates([...hr.value.finished, ...hr.value.created], hr.value.closings?.values()));
    const ctx: StatsContext = { now, limitMs: siteLimitMinutes() * 60_000, roster: roster.ids, includeImported, closings: hr.value.closings, importDetection };
    return { ok: true, v: { ds, now, week, currentWeek: weekKey(now), weeks, h: hr.value, roster, ctx, freshness: freshnessOf(ds, hr), importDetection } };
  } catch (e) {
    return { ok: false, freshness: freshnessOf(ds, null, isDataError(e) ? e : null), error: panelError(e, role), week, now };
  }
}

export function rowsOf(v: HistoryCtx, w: WeekRange, ctx: StatsContext = v.ctx): { created: TicketMeta[]; finished: TicketMeta[]; allCreated: TicketMeta[] } {
  return { created: createdIn(v.h.created, w, ctx), finished: finishedIn(v.h.finished, w, ctx), allCreated: createdIn(v.h.created, w, { ...ctx, includeImported: true }) };
}

/** Rows for several weeks together (a period). */
export function rowsOfRange(v: HistoryCtx, from: WeekRange, to: WeekRange): { created: TicketMeta[]; finished: TicketMeta[] } {
  const r = { start: from.start, end: to.end };
  return { created: createdIn(v.h.created, r, v.ctx), finished: finishedIn(v.h.finished, r, v.ctx) };
}

/**
 * People shown in the team table, the leaderboard and "average person": roster helpers and organizers with at least
 * one finished ticket or first reply in the period. People with nothing in the period are left out (e.g. a new helper).
 */
export function activePeople(v: HistoryCtx, created: readonly TicketMeta[], finished: readonly TicketMeta[]): string[] {
  const ids = [...new Set([...v.roster.helpers, ...v.roster.organizers])];
  return ids.filter(id => { const m = personMeasures(id, created, finished, v.ctx); return m.finished > 0 || m.firstReplies > 0; });
}

export const prevWeekKey = (k: string) => shiftWeek(k, -1);
