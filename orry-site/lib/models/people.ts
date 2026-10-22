/* getMeModel (My stats) and getLeaderboardModel (PLAN 4.17; mockups me.html, leaderboard.html).
   Only helper finishes count for a person: Orry's closes, participants' own closes and macro closes count for nobody.
   A median first reply needs at least 5 first replies. Ties share a rank. A person can hide from the leaderboard;
   the team row and the week matrix still count their tickets. */
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource } from "../data/types";
import { readOpenSet, readReopenInfo } from "../data/reads";
import { hasNoOwner, isOpen, needsHuman, STATUS_WORD, waitingSince, type BoardContext } from "../metrics/board";
import { MIN_N } from "../metrics/stats";
import { creditedHelper } from "../metrics/finishedBy";
import { dayTime, formatDuration, isoDuration, shortWeek, MIN } from "../metrics/time";
import { labelOf, personMeasures, rank, teamTotals } from "../metrics/week";
import { siteLimitMinutes } from "../data/clock";
import { resolvePeople, personRef, type PersonRef } from "../people";
import { activePeople, loadHistoryCtx, rowsOf, rowsOfRange, type HistoryCtx } from "./history";
import { weekHeader, type WeekHeader } from "./stats";
import { categoryLabel, compareCount, durOrFewShort, type Freshness, type PanelError } from "./shared";
import { preferences } from "./deps";
import { readHistoryTexts } from "../data/reads";
import { excerpt, slackToPlain } from "./text";

/* ---------------------------------- My stats ---------------------------------- */

export type MeModel = {
  freshness: Freshness;
  error: PanelError | null;
  me: PersonRef;
  role: "helper" | "organizer";
  onRoster: boolean;
  week: WeekHeader;
  title: string;                       // "Your numbers: 6 finished by you in week 42"
  strip: {
    finished: { value: number; team: number; line: string; compare: string | null };     // "of the team's 19", "Down from 7"
    open: { value: number; line: string; sub: string | null };                             // "Open on the board", "Assigned automatically"
    median: { value: string; tooFew: boolean; team: string; diff: string | null };        // "26 min", "team 38 min", "12 min faster"
    reopened: { value: number; of: number; line: string; team: string };                  // "1 of 11 first replies", "Team 4 of 41"
  };
  open: Array<{ id: number; href: string; status: string; statusText: string; category: string; categoryLabel: string; waitText: string; waitIso: string }>;
  openCaption: string;                 // "Right now · only you and organizers see this"
  trend: { weeks: Array<{ key: string; short: string; mine: number; average: number }>; total: number; sentence: string; caption: string; averageOf: number };
  finished: Array<{ id: number; href: string; question: string | null; questionNote: string | null; category: string; categoryLabel: string; closedText: string; tookText: string; firstReplyText: string | null }>;
  profile: { name: string | null; handle: string | null; roleText: string; showOnLeaderboard: boolean; leaderboardNote: string };
  notes: string[];
};

export async function getMeModel(s: Session, dsIn?: DataSource): Promise<MeModel> {
  const ds = dsIn ?? getDataSource();
  const r = await loadHistoryCtx(ds, s.role, null, false);
  const meFallback = personRef(s.slackId, { slackId: s.slackId, displayName: s.name, realName: null, username: s.handle, avatarUrl: null }, s.slackId);
  const show = await preferences().showOnLeaderboard(s.slackId).catch(() => true);
  const profile = (me: PersonRef, onRoster: boolean) => ({
    name: me.name, handle: me.handle, roleText: `${s.role === "organizer" ? "Organizer" : "Helper"}${onRoster ? " · on Orry's roster" : " · not on Orry's helper roster"}`,
    showOnLeaderboard: show, leaderboardNote: show ? "On: you are in the rows and top cards." : "Off: you are left out of the rows and top cards. Team totals still count your tickets."
  });
  if (!r.ok) {
    return {
      freshness: r.freshness, error: r.error, me: meFallback, role: s.role, onRoster: false, week: weekHeader(r.week, r.now, r.week.key), title: "Your numbers",
      strip: { finished: { value: 0, team: 0, line: "", compare: null }, open: { value: 0, line: "", sub: null }, median: { value: "", tooFew: true, team: "", diff: null }, reopened: { value: 0, of: 0, line: "", team: "" } },
      open: [], openCaption: "", trend: { weeks: [], total: 0, sentence: "", caption: "", averageOf: 0 }, finished: [], profile: profile(meFallback, false), notes: []
    };
  }
  const v = r.v;
  const w = v.week;
  const id = s.slackId;
  const cur = rowsOf(v, w), prev = rowsOf(v, v.weeks[v.weeks.length - 2]);
  const mine = personMeasures(id, cur.created, cur.finished, v.ctx);
  const minePrev = personMeasures(id, prev.created, prev.finished, v.ctx);
  const team = teamTotals(cur.created, cur.finished, v.ctx);

  // open with me now (the board's rule: needs a human, owned by me)
  let openRows: MeModel["open"] = [];
  try {
    const o = await readOpenSet(ds);
    const reopen = await readReopenInfo(ds, o.value.rows, v.roster.ids).catch(() => new Map());
    const ctx: BoardContext = { now: v.now, limitMs: siteLimitMinutes() * MIN, me: id, reopen };
    openRows = o.value.rows.filter(t => isOpen(t) && needsHuman(t) && t.assignee_id === id && !hasNoOwner(t, ctx) && t.visibility !== "dashboard").map(t => {
      const auto = t.status === "assigned" && t.claimed_at == null && t.assigned_at != null && t.assigned_at - t.created_at < 5 * MIN;
      const wait = Math.max(0, v.now - waitingSince(t).at);
      return {
        id: t.id, href: `/tickets/${t.id}`, status: t.status, statusText: auto ? "Assigned automatically" : STATUS_WORD[t.status] ?? t.status,
        category: t.category ?? "other", categoryLabel: categoryLabel(t.category), waitText: formatDuration(wait), waitIso: isoDuration(wait)
      };
    });
  } catch { openRows = []; }

  // 8-week trend: mine against the average active person
  const weeks8 = v.weeks.slice(-8);
  const span = rowsOfRange(v, weeks8[0], w);
  const active = activePeople(v, span.created, span.finished);
  const trend = weeks8.map(x => {
    const rr = rowsOf(v, x);
    const each = active.map(p => personMeasures(p, rr.created, rr.finished, v.ctx).finished);
    const sum = each.reduce((a, b) => a + b, 0);
    return { key: x.key, short: shortWeek(x.key), mine: personMeasures(id, rr.created, rr.finished, v.ctx).finished, average: active.length ? Math.round((sum / active.length) * 10) / 10 : 0 };
  });
  const total = trend.reduce((a, t) => a + t.mine, 0);
  const last = trend[trend.length - 1];

  // the tickets I finished this week
  const texts = await readHistoryTexts(ds, v.weeks[0].start, w.end).catch(() => new Map<number, string>());
  const people = await resolvePeople([id], { me: id, ds }).catch(() => new Map<string, PersonRef>());
  const me = people.get(id) ?? meFallback;
  const finished = cur.finished
    .filter(t => creditedHelper(t, labelOf(t, v.ctx), v.ctx.roster) === id)
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))
    .map(t => {
      const raw = texts.get(t.id);
      const hide = t.sensitive || t.outsideChannels || !!t.text_redacted_at || !raw;
      return {
        id: t.id, href: `/tickets/${t.id}`,
        question: hide ? null : excerpt(slackToPlain(raw!, people)),
        questionNote: t.sensitive ? "Sensitive message hidden. Open the ticket to reveal it (logged)." : hide ? "Text not shown." : null,
        category: t.category ?? "other", categoryLabel: categoryLabel(t.category), closedText: dayTime(t.resolved_at!),
        tookText: t.status === "resolved" ? formatDuration(t.resolved_at! - t.created_at) : "no resolution",
        firstReplyText: t.first_human_response_at != null ? formatDuration(t.first_human_response_at - t.created_at) : null
      };
    });

  const onRoster = v.roster.ids.has(id);
  const diff = !mine.firstReply.tooFew && team.firstReplyMedian != null && mine.firstReply.median != null
    ? (() => { const d = Math.round((team.firstReplyMedian - mine.firstReply.median) / MIN); return d > 0 ? `${d} min faster` : d < 0 ? `${-d} min slower` : "same as the team"; })()
    : null;
  return {
    freshness: v.freshness, error: null, me, role: s.role, onRoster, week: weekHeader(w, v.now, v.currentWeek),
    title: `Your numbers: ${mine.finished} finished by you in week ${w.week}`,
    strip: {
      finished: { value: mine.finished, team: team.finished, line: `of the team's ${team.finished}`, compare: compareCount(mine.finished, minePrev.finished) },
      open: { value: openRows.length, line: "Open on the board", sub: openRows.some(o => o.statusText === "Assigned automatically") ? "Assigned automatically" : null },
      median: { value: durOrFewShort(mine.firstReply.median, mine.firstReplies, mine.firstReply.tooFew), tooFew: mine.firstReply.tooFew, team: `team ${durOrFewShort(team.firstReplyMedian, team.firstReplies, team.firstReplyTooFew)}`, diff },
      reopened: { value: mine.reopened, of: mine.firstReplies, line: `${mine.reopened} of ${mine.firstReplies} first replies`, team: `Team ${team.reopened} of ${team.firstReplies}` }
    },
    open: openRows, openCaption: "Right now · only you and organizers see this",
    trend: {
      weeks: trend, total, averageOf: active.length,
      caption: `Weeks ${weeks8[0].week} to ${w.week} · ${total} finished`,
      sentence: `${last.mine} in week ${w.week}, against ${last.average.toFixed(1)} for the average person.`
    },
    finished,
    profile: profile(me, onRoster),
    notes: [
      "Finished by you: resolved or closed with you credited. Tickets Orry finished, participants closed themselves, or a macro closed count for nobody.",
      `First reply: your first message in the thread on a ticket created this week. The median needs at least ${MIN_N} first replies.`,
      "Only you and organizers see your open tickets. Everyone on the roster sees your finished, first-reply and reopened numbers unless you hide yourself."
    ]
  };
}

/** For the Profile switch (a server action in the UI calls this). */
export async function setShowOnLeaderboard(s: Session, show: boolean): Promise<void> {
  await preferences().setShowOnLeaderboard(s.slackId, show);
}

/* --------------------------------- Leaderboard --------------------------------- */

export type LeaderboardRow = {
  person: PersonRef;
  you: boolean;
  finished: number;
  firstReplies: number;
  median: string;                      // "26 min" or "Too few (n = 2)"
  medianMs: number | null;
  tooFew: boolean;
  reopened: number;
  reopenedText: string;                // "1 of 11"
  ranks: { finished: number | null; median: number | null; reopened: number | null };
};

export type LeaderboardModel = {
  freshness: Freshness;
  error: PanelError | null;
  week: WeekHeader;
  period: "week" | "8w";
  periods: Array<{ key: "week" | "8w"; label: string; current: boolean }>;
  periodLabel: string;                 // "Week 42" or "Weeks 35 to 42"
  title: string;                       // "Leaderboard: 6 tickets finished by you"
  rankLine: string | null;             // "6 finished by you · rank 1 of 5"
  rows: LeaderboardRow[];              // sorted by finished; the UI can re-sort by ranks.median / ranks.reopened
  tops: Array<{ key: "finished" | "median" | "reopened"; title: string; people: PersonRef[]; value: string; sub: string; tied: string | null }>;
  team: { finished: number; firstReplies: number; median: string; reopened: string };
  hiddenNote: string;                  // "1 hidden at their own request. The team row still counts them."
  matrix: { weeks: Array<{ key: string; short: string }>; rows: Array<{ person: PersonRef; you: boolean; values: number[]; total: number }>; hidden: { count: number; values: number[]; total: number } | null; team: { values: number[]; total: number } };
  rules: string[];
  reopenNote: string;
};

export async function getLeaderboardModel(s: Session, q: { period?: string | null } = {}, dsIn?: DataSource): Promise<LeaderboardModel> {
  const ds = dsIn ?? getDataSource();
  const period: "week" | "8w" = q.period === "8w" ? "8w" : "week";
  const r = await loadHistoryCtx(ds, s.role, null, false);
  const rules = [
    "Three measures, not one: finished, fastest first reply, fewest reopened. Reopened sits next to finished on purpose.",
    `A median first reply needs at least ${MIN_N} first replies; below that the row shows "Too few".`,
    "Tickets Orry finished, participants closed themselves and macro closes never count for anyone. Ties share a rank.",
    "You can hide yourself in My stats. The team row still counts your tickets."
  ];
  if (!r.ok) {
    return { freshness: r.freshness, error: r.error, week: weekHeader(r.week, r.now, r.week.key), period, periods: [], periodLabel: "", title: "Leaderboard", rankLine: null, rows: [], tops: [], team: { finished: 0, firstReplies: 0, median: "", reopened: "" }, hiddenNote: "", matrix: { weeks: [], rows: [], hidden: null, team: { values: [], total: 0 } }, rules, reopenNote: "" };
  }
  const v: HistoryCtx = r.v;
  const w = v.week;
  const weeks8 = v.weeks.slice(-8);
  const from = period === "week" ? w : weeks8[0];
  const span = rowsOfRange(v, from, w);
  const span8 = rowsOfRange(v, weeks8[0], w);
  const active = activePeople(v, span8.created, span8.finished);
  const hidden = await preferences().hiddenFromLeaderboard().catch(() => new Set<string>());
  const people = await resolvePeople([...active, s.slackId], { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (id: string) => people.get(id) ?? personRef(id, null, s.slackId);

  const measures = active.map(id => ({ id, m: personMeasures(id, span.created, span.finished, v.ctx) }));
  const shown = measures.filter(x => !hidden.has(x.id));
  const byName = (a: { id: string }, b: { id: string }) => P(a.id).label.localeCompare(P(b.id).label);
  const rf = rank(shown, x => x.m.finished, "high", byName);
  const rm = rank(shown, x => (x.m.firstReply.tooFew ? null : x.m.firstReply.median), "low", byName);
  const rr = rank(shown, x => (x.m.firstReplies ? x.m.reopened / x.m.firstReplies : null), "low", byName);
  const rankOf = (arr: Array<{ id: string; rank: number | null }>, id: string) => arr.find(x => x.id === id)?.rank ?? null;
  const rows: LeaderboardRow[] = rf.map(x => ({
    person: P(x.id), you: x.id === s.slackId, finished: x.m.finished, firstReplies: x.m.firstReplies,
    median: durOrFewShort(x.m.firstReply.median, x.m.firstReplies, x.m.firstReply.tooFew), medianMs: x.m.firstReply.tooFew ? null : x.m.firstReply.median, tooFew: x.m.firstReply.tooFew,
    reopened: x.m.reopened, reopenedText: `${x.m.reopened} of ${x.m.firstReplies}`,
    ranks: { finished: rankOf(rf, x.id), median: rankOf(rm, x.id), reopened: rankOf(rr, x.id) }
  }));

  const top = (arr: Array<{ id: string; m: (typeof measures)[number]["m"]; rank: number | null }>) => arr.filter(x => x.rank === 1);
  const tied = (n: number) => (n > 1 ? `Tied with ${n - 1} other${n > 2 ? "s" : ""}` : null);
  const tf = top(rf), tm = top(rm), tr = top(rr);
  const tops: LeaderboardModel["tops"] = [
    { key: "finished", title: "Most finished", people: tf.map(x => P(x.id)), value: tf[0] ? String(tf[0].m.finished) : "–", sub: "tickets", tied: tied(tf.length) },
    { key: "median", title: "Fastest first reply", people: tm.map(x => P(x.id)), value: tm[0] ? formatDuration(tm[0].m.firstReply.median!) : "Too few", sub: tm[0] ? `median · n ${tm[0].m.firstReplies}` : `nobody has ${MIN_N} first replies`, tied: tied(tm.length) },
    { key: "reopened", title: "Fewest reopened", people: tr.map(x => P(x.id)), value: tr[0] ? `${tr[0].m.reopened} of ${tr[0].m.firstReplies}` : "–", sub: "reopened", tied: tied(tr.length) }
  ];
  const tt = teamTotals(span.created, span.finished, v.ctx);
  const nHidden = measures.length - shown.length;
  const meRank = rf.find(x => x.id === s.slackId);
  const myFin = personMeasures(s.slackId, span.created, span.finished, v.ctx).finished;

  const perWeek = (id: string) => weeks8.map(x => { const rr2 = rowsOf(v, x); return personMeasures(id, rr2.created, rr2.finished, v.ctx).finished; });
  const visibleIds = active.filter(id => !hidden.has(id)).sort((a, b) => P(a).label.localeCompare(P(b).label));
  const hiddenIds = active.filter(id => hidden.has(id));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const teamWeekly = weeks8.map(x => { const rr2 = rowsOf(v, x); let n = 0; for (const t of rr2.finished) if (creditedHelper(t, labelOf(t, v.ctx), v.ctx.roster)) n++; return n; });
  const hiddenVals = weeks8.map((_, i) => sum(hiddenIds.map(id => perWeek(id)[i])));
  const periodLabel = period === "week" ? `Week ${w.week}` : `Weeks ${weeks8[0].week} to ${w.week}`;

  return {
    freshness: v.freshness, error: null, week: weekHeader(w, v.now, v.currentWeek), period,
    periods: [{ key: "week", label: `Week ${w.week}`, current: period === "week" }, { key: "8w", label: `Weeks ${weeks8[0].week} to ${w.week}`, current: period === "8w" }],
    periodLabel,
    title: s.role === "helper" && meRank ? `Leaderboard: ${myFin} tickets finished by you` : `Leaderboard: ${tt.finished} finished by the team`,
    rankLine: s.role === "helper" && meRank?.rank ? `${myFin} finished by you · rank ${meRank.rank} of ${shown.length}` : null,
    rows, tops,
    team: { finished: tt.finished, firstReplies: tt.firstReplies, median: durOrFewShort(tt.firstReplyMedian, tt.firstReplies, tt.firstReplyTooFew), reopened: `${tt.reopened} of ${tt.firstReplies}` },
    hiddenNote: nHidden ? `${nHidden} hidden at their own request. The team row still counts them.` : "Nobody is hidden.",
    matrix: {
      weeks: weeks8.map(x => ({ key: x.key, short: shortWeek(x.key) })),
      rows: visibleIds.map(id => { const vals = perWeek(id); return { person: P(id), you: id === s.slackId, values: vals, total: sum(vals) }; }),
      hidden: hiddenIds.length ? { count: hiddenIds.length, values: hiddenVals, total: sum(hiddenVals) } : null,
      team: { values: teamWeekly, total: sum(teamWeekly) }
    },
    rules,
    reopenNote: "Reopened is the share of the person's own first replies in the period that were reopened. The Statistics headline counts reopened tickets among all tickets created, so the two differ."
  };
}
