/* Board numbers, operational, "now" (PLAN 4.1 definitions, 5.2 K1-K9). Pure functions over open-set rows.
   "Open" has no creation window (the window-scoped trap, R03 Summary 18). A human reply is first_human_response_at,
   never first_response_at (Orry's status message stamps that one). */
import type { TicketMeta, TicketRow, TicketStatus } from "../data/types";
import { NEEDS_HUMAN_STATUSES, OPEN_STATUSES } from "../data/types";
import { HOUR, MIN } from "./time";

type Row = Pick<TicketRow, "id" | "status" | "assignee_id" | "assigned_at" | "created_at" | "updated_at" | "reopened_at" | "first_human_response_at" | "visibility"> & Partial<Pick<TicketMeta, "reopen_count" | "last_human_reply_at">>;

/** For reopened tickets the events decide (PLAN 4.1 reopen note); see lib/data/reads.ts readReopenInfo. */
export type ReopenFacts = { humanSince: boolean | "unknown"; ownerSince: boolean; truncated?: boolean };

export type BoardContext = {
  now: number;
  limitMs: number;                         // site limit L
  me?: string | null;                      // signed-in Slack ID
  reopen?: ReadonlyMap<number, ReopenFacts>;
  /** false when the program is set to dashboard-only visibility: then no ticket counts as imported (PLAN 4.1) */
  importDetection?: boolean;
};

export const isOpen = (t: Pick<Row, "status">): boolean => OPEN_STATUSES.includes(t.status);
/** Release writes status `open`, clears the owner and keeps `assigned_at` (lib/db.ts:1403-1410). */
export const isReleased = (t: Pick<Row, "status" | "assigned_at" | "assignee_id">): boolean => t.status === "open" && t.assigned_at != null && !t.assignee_id;
export const needsHuman = (t: Pick<Row, "status" | "assigned_at" | "assignee_id">): boolean => NEEDS_HUMAN_STATUSES.includes(t.status) || isReleased(t);
export const isImported = (t: Pick<Row, "visibility">, ctx?: Pick<BoardContext, "importDetection">): boolean => (ctx?.importDetection ?? true) && t.visibility === "dashboard";

/** Waiting since: reopened_at if reopened; updated_at for a released ticket (printed "at least"); else created_at. */
export function waitingSince(t: Row): { at: number; atLeast: boolean } {
  if (t.reopened_at != null) return { at: t.reopened_at, atLeast: false };
  if (isReleased(t)) return { at: t.updated_at ?? t.created_at, atLeast: true };
  return { at: t.created_at, atLeast: false };
}

/** Was there a human reply since "waiting since"? true / false / "unknown" (reopened and the events cannot tell). */
export function humanReplySince(t: Row, ctx: BoardContext): boolean | "unknown" {
  if (t.reopened_at != null) {
    // G29: last_human_reply_at moves on every human reply, so it decides when it is newer than the reopen
    if (t.last_human_reply_at != null && t.last_human_reply_at > t.reopened_at) return true;
    const f = ctx.reopen?.get(t.id);
    return f ? f.humanSince : "unknown";
  }
  return t.first_human_response_at != null;
}

/** No owner: no assignee, or reopened with no assigned/claimed event after the reopen (the old owner is "previously"). */
export function hasNoOwner(t: Row, ctx: BoardContext): boolean {
  if (!t.assignee_id) return true;
  if (t.status === "reopened") return !(ctx.reopen?.get(t.id)?.ownerSince ?? false);
  return false;
}

/** The previous owner shown as "Previously <name>" on a reopened ticket that nobody has taken again. */
export function previousOwner(t: Row, ctx: BoardContext): string | null {
  return t.status === "reopened" && t.assignee_id && hasNoOwner(t, ctx) ? t.assignee_id : null;
}

export type LimitChip = "over" | "near" | "unknown" | null;

export function limitChip(t: Row, ctx: BoardContext): LimitChip {
  if (!needsHuman(t)) return null;
  const reply = humanReplySince(t, ctx);
  if (reply === true) return null;
  if (reply === "unknown") return "unknown";
  const wait = ctx.now - waitingSince(t).at;
  if (wait > ctx.limitMs) return "over";
  if (wait > 0.75 * ctx.limitMs) return "near";
  return null;
}

export const AGE_BUCKETS = [
  { key: "lt1", label: "Under 1 h", lo: 0, hi: HOUR },
  { key: "1to6", label: "1 to 6 h", lo: HOUR, hi: 6 * HOUR },
  { key: "6to24", label: "6 to 24 h", lo: 6 * HOUR, hi: 24 * HOUR },
  { key: "1to2d", label: "1 to 2 days", lo: 24 * HOUR, hi: 48 * HOUR },
  { key: "gt2d", label: "Over 2 days", lo: 48 * HOUR, hi: Infinity }
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"];
export const ageBucket = (waitMs: number): AgeBucket => AGE_BUCKETS.find(b => waitMs >= b.lo && waitMs < b.hi)!.key;

export const VIEW_KEYS = ["human", "mine", "noowner", "orry", "48h", "imp", "parked", "all"] as const;
export type BoardView = (typeof VIEW_KEYS)[number];

/** Which views a row belongs to (PLAN 4.1 Views). Parked rows come from a separate read. */
export function viewsOf(t: Row, ctx: BoardContext): BoardView[] {
  const v: BoardView[] = [];
  const imp = isImported(t, ctx);
  if (t.status === "snoozed" || t.status === "duplicate") return ["parked"];
  if (!isOpen(t)) return v;
  v.push("all");
  if (imp) { v.push("imp"); return v; }
  const nh = needsHuman(t);
  if (nh) {
    v.push("human");
    if (hasNoOwner(t, ctx)) v.push("noowner");
    if (ctx.now - waitingSince(t).at > 48 * HOUR) v.push("48h");
  }
  if (t.status === "open" && t.assigned_at == null) v.push("orry");
  if (ctx.me && t.assignee_id === ctx.me && t.status !== "reopened") v.push("mine");
  return v;
}

export type Headline = {
  needHuman: number;                 // K1
  waitingFirstReply: number;         // K1 split: no human reply since waiting since (unknown counted here)
  inProgress: number;                // K1 split: a human replied since waiting since
  noOwner: number;                   // K2
  oldest: { id: number; waitMs: number; atLeast: boolean } | null;  // K3
  over: number;                      // K4
  near: number;
  unknown: number;
  openAll: number;                   // K5 (imports included)
  orryOrUnconfirmed: number;         // K6
  imported: number;                  // K7
  over48h: number;                   // K9 (site set: needs a human, not imported)
};

/** K1-K9 over the whole open set (imported rows excluded except where named). */
export function headline(rows: readonly Row[], ctx: BoardContext): Headline {
  const open = rows.filter(isOpen);
  const base = open.filter(t => needsHuman(t) && !isImported(t, ctx));
  let waiting = 0, progress = 0, over = 0, near = 0, unknown = 0, noOwner = 0, over48 = 0;
  let oldest: Headline["oldest"] = null;
  for (const t of base) {
    const reply = humanReplySince(t, ctx);
    if (reply === true) progress++; else waiting++;
    const chip = limitChip(t, ctx);
    if (chip === "over") over++; else if (chip === "near") near++; else if (chip === "unknown") unknown++;
    if (hasNoOwner(t, ctx)) noOwner++;
    const ws = waitingSince(t);
    const wait = ctx.now - ws.at;
    if (wait > 48 * HOUR) over48++;
    if (!oldest || wait > oldest.waitMs) oldest = { id: t.id, waitMs: wait, atLeast: ws.atLeast };
  }
  return {
    needHuman: base.length, waitingFirstReply: waiting, inProgress: progress, noOwner, oldest, over, near, unknown,
    openAll: open.length,
    orryOrUnconfirmed: open.filter(t => t.status === "open" && t.assigned_at == null && !isImported(t, ctx)).length,
    imported: open.filter(t => isImported(t, ctx)).length,
    over48h: over48
  };
}

export type LoadItem = { key: string; n: number; oldestMs: number | null; over: number };

/** "Who has what": needs-a-human rows per owner, plus "_none" for no owner (mockups 13.5). */
export function load(rows: readonly Row[], ctx: BoardContext, roster: readonly string[]): LoadItem[] {
  const base = rows.filter(t => isOpen(t) && needsHuman(t) && !isImported(t, ctx));
  const keyOf = (t: Row) => (hasNoOwner(t, ctx) ? "_none" : t.assignee_id!);
  const keys = ["_none", ...roster, ...new Set(base.map(keyOf).filter(k => k !== "_none" && !roster.includes(k)))];
  return keys.map(key => {
    const mine = base.filter(t => keyOf(t) === key);
    return {
      key, n: mine.length,
      oldestMs: mine.length ? Math.max(...mine.map(t => ctx.now - waitingSince(t).at)) : null,
      over: mine.filter(t => limitChip(t, ctx) === "over").length
    };
  });
}

/** Queue shape (K8): rows of a view by waiting time, buckets lined up with the 2 h default limit. */
export const SHAPE_BUCKETS = [
  { label: "Under 1 h", lo: 0, hi: HOUR }, { label: "1 to 2 h", lo: HOUR, hi: 2 * HOUR }, { label: "2 to 6 h", lo: 2 * HOUR, hi: 6 * HOUR },
  { label: "6 to 24 h", lo: 6 * HOUR, hi: 24 * HOUR }, { label: "Over 24 h", lo: 24 * HOUR, hi: Infinity }
] as const;
export function queueShape(rows: readonly Row[], ctx: BoardContext): Array<{ label: string; n: number }> {
  return SHAPE_BUCKETS.map(b => ({ label: b.label, n: rows.filter(t => { const w = ctx.now - waitingSince(t).at; return w >= b.lo && w < b.hi; }).length }));
}

export const STATUS_WORD: Record<TicketStatus | "released", string> = {
  waiting_for_helper: "Waiting", escalated: "Escalated", reopened: "Reopened", assigned: "Assigned", claimed: "Claimed",
  open: "Answered or unconfirmed", released: "Released", snoozed: "Parked (never wakes)", duplicate: "Duplicate",
  resolved: "Resolved", closed: "Closed", waiting_for_user: "Waiting for the participant"
};

export { MIN };
