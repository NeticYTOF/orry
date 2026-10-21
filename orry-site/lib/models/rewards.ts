/* getRewardsModel: the weekly top 3 in each of four categories, the viewer's own standing in each, and last week's
   winners. Same counting rules as the Leaderboard (only helper finishes count; Orry's closes, participants' own
   closes and macro closes count for nobody; ties share a rank; people who hid themselves are left out). */
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource } from "../data/types";
import { MIN_N } from "../metrics/stats";
import { dayMonth, formatDuration, type WeekRange } from "../metrics/time";
import { personMeasures, rank } from "../metrics/week";
import { personRef, resolvePeople, type PersonRef } from "../people";
import { activePeople, loadHistoryCtx, rowsOf, type HistoryCtx } from "./history";
import { weekHeader, type WeekHeader } from "./stats";
import type { Freshness, PanelError } from "./shared";
import { preferences } from "./deps";

export type CategoryKey = "finished" | "speed" | "reopened" | "replies";

export type PodiumEntry = { person: PersonRef; you: boolean; rank: number; value: string; sub: string };
export type Podium = {
  key: CategoryKey;
  title: string;          // "Most finished"
  unit: string;           // one plain line on what is counted
  rule: string;           // who qualifies
  entries: PodiumEntry[]; // everyone with rank 1 to 3 (ties share a rank)
};

export type Standing = {
  key: CategoryKey;
  title: string;
  state: "podium" | "chase" | "out";
  rank: number | null;
  value: string;          // my number in this category
  line: string;           // what it means / what is missing
};

export type RewardsModel = {
  freshness: Freshness;
  error: PanelError | null;
  role: "helper" | "organizer";
  week: WeekHeader;
  /** "2 d 9 h" while the week is running, else null */
  leftText: string | null;
  /** "Closes Monday 26 Oct, 00:00 UTC" */
  closesText: string;
  podiums: Podium[];
  /** null when the viewer is hidden or is not on the roster */
  standing: Standing[] | null;
  standingNote: string | null;
  last: { label: string; provisionalNote: string | null; podiums: Podium[] } | null;
  rules: string[];
};

type Scored = { id: string; finished: number; replies: number; median: number | null; reopened: number };

const CATS: Array<{ key: CategoryKey; title: string; unit: string; rule: string }> = [
  { key: "finished", title: "Most finished", unit: "Tickets you resolved or closed with your name on them", rule: "At least 1 finished." },
  { key: "speed", title: "Fastest first reply", unit: "Median time from a ticket opening to your first message", rule: `At least ${MIN_N} first replies.` },
  { key: "reopened", title: "Fewest reopened", unit: "Share of your first replies that were reopened later", rule: `At least ${MIN_N} first replies.` },
  { key: "replies", title: "Most first replies", unit: "Tickets where you were the first person to answer", rule: "At least 1 first reply." }
];

function score(v: HistoryCtx, w: WeekRange, hidden: Set<string>): Scored[] {
  const r = rowsOf(v, w);
  return activePeople(v, r.created, r.finished)
    .filter(id => !hidden.has(id))
    .map(id => {
      const m = personMeasures(id, r.created, r.finished, v.ctx);
      return { id, finished: m.finished, replies: m.firstReplies, median: m.firstReply.tooFew ? null : m.firstReply.median, reopened: m.reopened };
    });
}

/** The number each category ranks by; null = does not qualify. */
function valueOf(key: CategoryKey, s: Scored): number | null {
  switch (key) {
    case "finished": return s.finished > 0 ? s.finished : null;
    case "speed": return s.median;
    case "reopened": return s.replies >= MIN_N ? s.reopened / s.replies : null;
    case "replies": return s.replies > 0 ? s.replies : null;
  }
}
const better = (key: CategoryKey): "low" | "high" => (key === "speed" || key === "reopened" ? "low" : "high");

function show(key: CategoryKey, s: Scored): { value: string; sub: string } {
  switch (key) {
    case "finished": return { value: String(s.finished), sub: s.finished === 1 ? "ticket" : "tickets" };
    case "speed": return { value: s.median == null ? "–" : formatDuration(s.median), sub: `median · n ${s.replies}` };
    case "reopened": return { value: `${s.reopened} of ${s.replies}`, sub: "reopened" };
    case "replies": return { value: String(s.replies), sub: s.replies === 1 ? "first reply" : "first replies" };
  }
}

function ranked(key: CategoryKey, rows: Scored[]) {
  return rank(rows, r => valueOf(key, r), better(key), (a, b) => a.id.localeCompare(b.id));
}

function podiums(rows: Scored[], P: (id: string) => PersonRef, me: string): Podium[] {
  return CATS.map(c => {
    const top = ranked(c.key, rows).filter(r => r.rank != null && r.rank <= 3);
    const entries = top.map(r => ({ person: P(r.id), you: r.id === me, rank: r.rank as number, ...show(c.key, r) }))
      .sort((a, b) => a.rank - b.rank || a.person.label.localeCompare(b.person.label));
    return { key: c.key, title: c.title, unit: c.unit, rule: c.rule, entries };
  });
}

function standingFor(rows: Scored[], me: string): Standing[] | null {
  const mine = rows.find(r => r.id === me);
  if (!mine) return null;
  return CATS.map(c => {
    const own = show(c.key, mine);
    const val = valueOf(c.key, mine);
    if (val == null) {
      const need = c.key === "speed" || c.key === "reopened"
        ? `Needs ${Math.max(1, MIN_N - mine.replies)} more first ${MIN_N - mine.replies === 1 ? "reply" : "replies"} to qualify.`
        : c.key === "finished" ? "Finish a ticket to get on the board." : "Be the first to answer a ticket to get on the board.";
      return { key: c.key, title: c.title, state: "out" as const, rank: null, value: c.key === "finished" || c.key === "replies" ? "0" : "–", line: need };
    }
    const list = ranked(c.key, rows);
    const me2 = list.find(r => r.id === me)!;
    if (me2.rank != null && me2.rank <= 3) {
      const ties = list.filter(r => r.rank === me2.rank).length - 1;
      return { key: c.key, title: c.title, state: "podium" as const, rank: me2.rank, value: own.value, line: `On the podium${ties ? `, tied with ${ties} other${ties > 1 ? "s" : ""}` : ""}.` };
    }
    const third = list.filter(r => r.rank != null && r.rank <= 3).pop();
    let line = "Not on the podium yet.";
    if (third) {
      const t = show(c.key, third);
      if (c.key === "finished" || c.key === "replies") {
        const d = (valueOf(c.key, third) as number) - (val as number);
        line = `${d} more to reach 3rd place (${t.value}).`;
      } else if (c.key === "speed") line = `3rd place is ${t.value}. Yours is ${own.value}.`;
      else line = `3rd place has ${t.value} reopened. You have ${own.value}.`;
    }
    return { key: c.key, title: c.title, state: "chase" as const, rank: me2.rank, value: own.value, line };
  });
}

export async function getRewardsModel(s: Session, dsIn?: DataSource): Promise<RewardsModel> {
  const ds = dsIn ?? getDataSource();
  const r = await loadHistoryCtx(ds, s.role, null, false);
  const rules = [
    "Everyone with a rank of 1, 2 or 3 in a category is on its podium. Ties share a rank, so a podium can hold more than three people.",
    "Only tickets finished by a helper count. Tickets Orry finished, participants closed themselves and macro closes count for nobody.",
    `Speed and reopened need at least ${MIN_N} first replies in the week, so a lucky single reply cannot win.`,
    "The week runs Monday 00:00 to Sunday 24:00 UTC. Late closes can still move a finished week for 7 days, so last week's podium is provisional until then.",
    "You can hide yourself in Settings. Hidden people are left out of every podium."
  ];
  if (!r.ok) {
    const hdr = weekHeader(r.week, r.now, r.week.key);
    return { freshness: r.freshness, error: r.error, role: s.role, week: hdr, leftText: null, closesText: "", podiums: [], standing: null, standingNote: null, last: null, rules };
  }
  const v = r.v;
  const w = v.week;
  const hidden = await preferences().hiddenFromLeaderboard().catch(() => new Set<string>());
  const curRows = score(v, w, hidden);
  const prevWeek = v.weeks.length > 1 ? v.weeks[v.weeks.length - 2] : null;
  const prevRows = prevWeek ? score(v, prevWeek, hidden) : [];

  const ids = [...new Set([...curRows, ...prevRows].map(x => x.id)), s.slackId];
  const people = await resolvePeople(ids, { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (id: string) => people.get(id) ?? personRef(id, null, s.slackId);

  const hdr = weekHeader(w, v.now, v.currentWeek);
  const running = v.now < w.end;
  const standing = standingFor(curRows, s.slackId);
  const imHidden = hidden.has(s.slackId);
  const prevHdr = prevWeek ? weekHeader(prevWeek, v.now, v.currentWeek) : null;
  return {
    freshness: v.freshness, error: null, role: s.role, week: hdr,
    leftText: running ? formatDuration(w.end - v.now) : null,
    closesText: `${running ? "Closes" : "Closed"} ${dayMonth(w.end)}, 00:00 UTC`,
    podiums: podiums(curRows, P, s.slackId),
    standing,
    standingNote: imHidden ? "You are hidden from the rankings, so you are not on any podium. You can change this in Settings." : standing ? null : "You have no finished tickets or first replies this week yet.",
    last: prevWeek && prevHdr ? { label: prevHdr.label, provisionalNote: prevHdr.provisionalUntil ? `Provisional until ${prevHdr.provisionalUntil}` : null, podiums: podiums(prevRows, P, s.slackId) } : null,
    rules
  };
}
