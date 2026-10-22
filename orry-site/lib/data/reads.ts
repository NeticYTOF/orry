/* Reads built on the DataSource: paging, completeness checks, stripping and caching (PLAN 4.1 Data, 4.3 Data, 6.4, 6.5).
   Both sources go through here, so the fixtures exercise the same paging code as the real bridge. */
import type { ClosingInfo, DataSource, ProgramConfig, TicketDetail, TicketMeta, TicketPage, TicketRow, TicketSearch, WaitEstimate } from "./types";
import { DataError, NEEDS_HUMAN_STATUSES } from "./types";
import { MemoCache, type Read } from "./cache";
import { toMeta } from "./strip";

export const PAGE = 200;
export const MAX_PAGES = 5;          // the 1,000-row cap
const MIN = 60_000;

/* ---------- paging ---------- */

export type Paged = { rows: TicketRow[]; total: number; complete: boolean; capped: boolean; refetched: boolean };

/**
 * Pages a created_at-ordered search (`sort=waiting` or `sort=created`) to `total`. The ORDER BY has one column and no
 * id tie-break, so rows that share a timestamp can be skipped or repeated across pages. After paging, if the distinct
 * count is below `total`, the rows at each page-boundary timestamp are fetched again with since/until (created_at = t),
 * then, if still short, the whole set once more.
 */
export async function pageByCreated(ds: DataSource, q: Omit<TicketSearch, "limit" | "offset">): Promise<Paged> {
  const run = async (): Promise<{ byId: Map<number, TicketRow>; total: number; boundaries: number[]; capped: boolean }> => {
    const byId = new Map<number, TicketRow>();
    const boundaries: number[] = [];
    let total = 0, offset = 0, capped = false;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { capped = true; break; }
      const res: TicketPage = await ds.searchTickets({ ...q, limit: PAGE, offset });
      total = res.total;
      for (const r of res.rows) byId.set(r.id, r);
      if (res.rows.length) boundaries.push(res.rows[res.rows.length - 1].created_at);
      offset += res.rows.length;
      if (res.rows.length < PAGE || offset >= res.total) break;
    }
    return { byId, total, boundaries, capped };
  };
  let r = await run();
  let refetched = false;
  if (!r.capped && r.byId.size < r.total) {
    for (const t of new Set(r.boundaries)) {
      const lo = q.since != null ? Math.max(q.since, t - 1) : t - 1;
      const hi = q.until != null ? Math.min(q.until, t) : t;
      if (hi <= lo) continue;
      const probe = await ds.searchTickets({ ...q, since: lo, until: hi, limit: PAGE, offset: 0 });
      for (const row of probe.rows) r.byId.set(row.id, row);
    }
    if (r.byId.size < r.total) { r = await run(); refetched = true; }
  }
  const complete = !r.capped && r.byId.size >= r.total;
  return { rows: [...r.byId.values()], total: r.total, complete, capped: r.capped, refetched };
}

/**
 * Pages `sort=updated` (newest first) until a page reaches `updated_at < stopBefore`. A ticket finished in a week always
 * has `updated_at` after that week's start (resolve and close write it), so stopping there is complete, except for the
 * history importer's rewrites (PLAN 4.3). If two pages meet on an equal `updated_at`, or a row repeats, a second pass
 * with a different page size moves the boundaries and the union is kept.
 */
export async function pageByUpdated(ds: DataSource, q: Omit<TicketSearch, "limit" | "offset" | "sort">, stopBefore: number): Promise<{ rows: TicketRow[]; reached: number; capped: boolean; tieRepair: boolean }> {
  const run = async (size: number) => {
    const byId = new Map<number, TicketRow>();
    let offset = 0, capped = false, reached = Infinity, risky = false, lastPrev: number | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { capped = true; break; }
      const res = await ds.searchTickets({ ...q, sort: "updated", limit: size, offset });
      for (const row of res.rows) { if (byId.has(row.id)) risky = true; byId.set(row.id, row); }
      if (res.rows.length) {
        const first = res.rows[0].updated_at ?? 0, last = res.rows[res.rows.length - 1].updated_at ?? 0;
        if (lastPrev !== null && first === lastPrev) risky = true;
        lastPrev = last;
        reached = Math.min(reached, last);
      }
      offset += res.rows.length;
      if (res.rows.length < size || offset >= res.total) { reached = -Infinity; break; }
      if (reached < stopBefore) break;
    }
    return { byId, capped, reached, risky };
  };
  const a = await run(PAGE);
  if (!a.risky) return { rows: [...a.byId.values()], reached: a.reached, capped: a.capped, tieRepair: false };
  const b = await run(PAGE - 1);
  for (const [id, row] of b.byId) if (!a.byId.has(id)) a.byId.set(id, row);
  return { rows: [...a.byId.values()], reached: Math.min(a.reached, b.reached), capped: a.capped && b.capped, tieRepair: true };
}

/* ---------- caches ---------- */

const dropRowsText = <T extends { rows: TicketRow[] }>(v: T): T => ({ ...v, rows: v.rows.map(r => ({ ...r, question: "", summary: null, resolution: null })) });

const openCache = new MemoCache<Paged>("open", { ttlMs: 30_000, dropText: dropRowsText });
const parkedCache = new MemoCache<{ rows: TicketRow[] }>("parked", { ttlMs: 5 * MIN, dropText: dropRowsText });
const programCache = new MemoCache<ProgramConfig>("program", { ttlMs: 5 * MIN });
const waitCache = new MemoCache<WaitEstimate>("wait", { ttlMs: 5 * MIN });
const rosterCache = new MemoCache<RosterInfo>("roster", { ttlMs: 5 * MIN });
const detailCache = new MemoCache<TicketDetail | null>("detail", {
  ttlMs: 15_000,
  dropText: d => (d ? { ...d, ticket: { ...d.ticket, question: "", summary: null, resolution: null }, notes: d.notes.map(n => ({ ...n, body: "" })) } : d)
});
const reopenCache = new MemoCache<ReopenInfo>("reopen", { ttlMs: 2 * MIN });
const historyCache = new MemoCache<History>("history", { ttlMs: 10 * MIN });
/** Question text of finished tickets for the ledger: at most 2 minutes, then refetched with the rows. */
const historyText = new MemoCache<Map<number, string>>("history-text", { ttlMs: 2 * MIN, textMaxMs: 2 * MIN, dropText: () => new Map() });

export function readCaches() {
  return { openCache, parkedCache, programCache, waitCache, rosterCache, detailCache, reopenCache, historyCache, historyText };
}

/** ORRY_FIXTURE_STATE=stale|offline makes the fixtures look old, so the UI states can be seen locally. */
function simulate<T>(ds: DataSource, r: Read<T>): Read<T> {
  const s = (ds as { simulatedState?: string }).simulatedState;
  if (s === "stale") return { ...r, stale: true, fetchedAt: r.fetchedAt - 11 * MIN, error: new DataError("offline", "Orry did not answer (simulated).") };
  return r;
}

/* ---------- board ---------- */

export async function readOpenSet(ds: DataSource): Promise<Read<Paged>> {
  return simulate(ds, await openCache.get(ds.mode, () => pageByCreated(ds, { statusGroup: "open", sort: "waiting" })));
}

export async function readParked(ds: DataSource): Promise<Read<{ rows: TicketRow[] }>> {
  return simulate(ds, await parkedCache.get(ds.mode, async () => {
    const [a, b] = await Promise.all([
      pageByCreated(ds, { status: "snoozed", sort: "waiting" }),
      pageByCreated(ds, { status: "duplicate", sort: "waiting" })
    ]);
    return { rows: [...a.rows, ...b.rows] };
  }));
}

export async function readProgram(ds: DataSource): Promise<Read<ProgramConfig>> {
  return programCache.get(ds.mode, () => ds.program());
}

export async function readWait(ds: DataSource): Promise<Read<WaitEstimate>> {
  return waitCache.get(ds.mode, () => ds.waitEstimate());
}

export type RosterInfo = { ids: Set<string>; helpers: string[]; organizers: string[] };
export async function readRoster(ds: DataSource): Promise<Read<RosterInfo>> {
  return rosterCache.get(ds.mode, async () => {
    const r = await ds.roster();
    return { ids: new Set(r.map(p => p.id)), helpers: r.filter(p => p.role === "helper").map(p => p.id), organizers: r.filter(p => p.role === "organizer").map(p => p.id) };
  });
}

export async function readDetail(ds: DataSource, id: number): Promise<Read<TicketDetail | null>> {
  return detailCache.get(`${ds.mode}:${id}`, () => ds.ticketDetail(id));
}

/* ---------- reopened tickets: was there a human since the reopen? (PLAN 4.1 reopen note) ---------- */

export type ReopenInfo = {
  /** a helper_reply, claimed or assigned event by a roster member after reopened_at; "unknown" when it cannot be seen */
  humanSince: boolean | "unknown";
  /** an assigned or claimed event after reopened_at: the owner counts again */
  ownerSince: boolean;
  /** the detail route returned 100 events (the newest may be missing) */
  truncated: boolean;
  checked: boolean;
};

export function reopenFromEvents(d: TicketDetail, reopenedAt: number, roster: ReadonlySet<string>): ReopenInfo {
  const after = d.events.filter(e => e.created_at >= reopenedAt && e.event_type !== "reopened");
  const human = after.some(e => (e.event_type === "helper_reply" || e.event_type === "claimed" || e.event_type === "assigned") && e.actor_id != null && roster.has(e.actor_id));
  const owner = after.some(e => e.event_type === "claimed" || e.event_type === "assigned");
  // What is missing depends on the window: the oldest page (before G10) can miss everything after the reopen; the
  // newest page (G10) misses only events older than its first one, so it is complete when that is before the reopen.
  const blind = d.eventsTruncated && (d.eventsWindow !== "newest" || !d.events.length || d.events[0].created_at > reopenedAt);
  return { humanSince: human ? true : blind ? "unknown" : false, ownerSince: owner, truncated: blind, checked: true };
}

/**
 * The roster plus any organizers among `candidates`. Core's helpers route lists helpers only, so on the bridge the
 * organizers (Core's admin list) are found by asking the access route about the people the data names: owners,
 * first responders, credited helpers and helper closes (DataSource.organizersAmong). Sources without that method
 * already list their organizers. Never fails: on error the roster is returned as it was.
 */
export async function withOrganizers(ds: DataSource, r: RosterInfo, candidates: Iterable<string | null | undefined>): Promise<RosterInfo> {
  if (!ds.organizersAmong) return r;
  const ids = [...new Set([...candidates].filter((x): x is string => !!x && !r.ids.has(x)))];
  if (!ids.length) return r;
  const found = await ds.organizersAmong(ids).catch(() => [] as string[]);
  const extra = found.filter(id => !r.organizers.includes(id));
  if (!extra.length) return r;
  return { ids: new Set([...r.ids, ...extra]), helpers: r.helpers, organizers: [...r.organizers, ...extra] };
}

/** The people a set of ticket rows and closing rows names as owners, first responders, credited helpers or helper closers. */
export function staffCandidates(rows: Iterable<Pick<TicketRow, "assignee_id" | "first_responder_id" | "resolved_credit_id">>, closings?: Iterable<ClosingInfo> | null): string[] {
  const out = new Set<string>();
  for (const r of rows) for (const x of [r.assignee_id, r.first_responder_id, r.resolved_credit_id]) if (x) out.add(x);
  for (const c of closings ?? []) if (c.actorKind === "helper" && c.actorId) out.add(c.actorId);
  return [...out];
}

let lastBackgroundCheck = 0;
/**
 * For open tickets with `reopened_at`: fixtures check at once; the bridge checks at most one ticket every 5 s in the
 * background and reports "unknown" until then.
 */
export async function readReopenInfo(ds: DataSource, rows: readonly TicketRow[], roster: ReadonlySet<string>): Promise<Map<number, ReopenInfo>> {
  const out = new Map<number, ReopenInfo>();
  const todo = rows.filter(r => r.reopened_at != null && (NEEDS_HUMAN_STATUSES.includes(r.status) || r.status === "open"));
  for (const r of todo) {
    const key = `${ds.mode}:${r.id}:${r.reopened_at}`;
    const hit = reopenCache.peek(key);
    if (hit && Date.now() - hit.at < 2 * MIN) { out.set(r.id, hit.value); continue; }
    const now = Date.now();
    if (ds.mode === "fixtures" || now - lastBackgroundCheck >= 5_000) {
      lastBackgroundCheck = now;
      const load = async () => { const d = await ds.ticketDetail(r.id); return d ? reopenFromEvents(d, r.reopened_at!, roster) : { humanSince: "unknown" as const, ownerSince: false, truncated: false, checked: true }; };
      if (ds.mode === "fixtures") { try { out.set(r.id, (await reopenCache.get(key, load)).value); continue; } catch { /* fall through */ } }
      else void reopenCache.get(key, load).catch(() => undefined);
    }
    out.set(r.id, hit?.value ?? { humanSince: "unknown", ownerSince: false, truncated: false, checked: false });
  }
  return out;
}

/* ---------- history (statistics, closed ledger, my stats, leaderboard) ---------- */

export type History = {
  /** finished with resolved_at in [start, end), text removed */
  finished: TicketMeta[];
  /** created_at in [start, end), text removed */
  created: TicketMeta[];
  closings: Map<number, ClosingInfo> | null;   // G9; null when not deployed
  start: number;
  end: number;
  /** week start (ms) → why that week is not complete, for weeks that are not */
  incomplete: Map<number, string>;
};

const WEEK = 7 * 24 * 60 * MIN;

async function loadHistory(ds: DataSource, start: number, end: number, channels: readonly string[]): Promise<{ h: History; texts: Map<number, string> }> {
  const [res, clo, created, closings] = await Promise.all([
    pageByUpdated(ds, { statusGroup: "resolved" }, start),
    pageByUpdated(ds, { status: "closed" }, start),
    pageByCreated(ds, { since: start - 1, until: end - 1, sort: "created" }),
    ds.closings(start, end).catch(() => null)
  ]);
  const texts = new Map<number, string>();
  const finishedRows = [...res.rows, ...clo.rows].filter(r => r.resolved_at != null && r.resolved_at >= start && r.resolved_at < end && (r.status === "resolved" || r.status === "closed"));
  for (const r of finishedRows) texts.set(r.id, r.question);
  const incomplete = new Map<number, string>();
  const reached = Math.max(res.reached, clo.reached);
  for (let w = start; w < end; w += WEEK) {
    if ((res.capped || clo.capped) && reached > w) incomplete.set(w, "the 1,000-row cap was reached before this week's start");
    if (!created.complete) incomplete.set(w, created.capped ? "the 1,000-row cap was reached before this week's start" : "Orry's ticket list changed while it was read");
  }
  return {
    h: {
      finished: finishedRows.map(r => toMeta(r, channels)),
      created: created.rows.filter(r => r.created_at >= start && r.created_at < end).map(r => toMeta(r, channels)),
      closings: closings ? new Map(closings.map(c => [c.ticketId, c])) : null,
      start, end, incomplete
    },
    texts
  };
}

export async function readHistory(ds: DataSource, start: number, end: number): Promise<Read<History>> {
  const program = await readProgram(ds).catch(() => null);
  const channels = program?.value.channels ?? [];
  const key = `${ds.mode}:${start}:${end}`;
  return simulate(ds, await historyCache.get(key, async () => {
    const { h, texts } = await loadHistory(ds, start, end, channels);
    historyText.set(key, texts);
    return h;
  }));
}

/** Question text for finished tickets in a range, at most 2 minutes old (refetches the rows when older). */
export async function readHistoryTexts(ds: DataSource, start: number, end: number): Promise<Map<number, string>> {
  const key = `${ds.mode}:${start}:${end}`;
  const t = historyText.peek(key);
  if (t && Date.now() - t.at < 2 * MIN && !t.textDropped) return t.value;
  const program = await readProgram(ds).catch(() => null);
  const { h, texts } = await loadHistory(ds, start, end, program?.value.channels ?? []);
  historyCache.set(key, h);
  historyText.set(key, texts);
  return texts;
}
