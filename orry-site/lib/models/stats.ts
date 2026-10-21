/* getStatsModel: Statistics for one ISO week (PLAN 4.3, 5.3, 5.4; mockup stats.html). */
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource, FinishedByLabel } from "../data/types";
import { LABEL_NAME, LABEL_ORDER } from "../metrics/finishedBy";
import { MIN_N, pct, upperMedian } from "../metrics/stats";
import { dayMonth, formatDuration, hhmm, shiftWeek, shortWeek, weekSpanLabel, MIN, type WeekRange } from "../metrics/time";
import { byCategory, heatmap, heatStep, personMeasures, provisional, teamTotals, weekStats, type WeekStats } from "../metrics/week";
import { resolvePeople, personRef, type PersonRef } from "../people";
import { activePeople, loadHistoryCtx, rowsOf, type HistoryCtx } from "./history";
import { categoryLabel, compareCount, compareDuration, comparePct, durOrFew, durOrFewShort, pctText, type Freshness, type PanelError } from "./shared";

export type WeekHeader = {
  key: string;                 // "2026-W42"
  short: string;               // "W42"
  label: string;               // "Week 42"
  span: string;                // "12 to 18 Oct"
  year: number;
  partial: boolean;            // "This week so far"
  provisional: boolean;
  provisionalUntil: string | null;   // "25 Oct"
  chip: string | null;         // "Provisional until 25 Oct"
  prev: { key: string; label: string } | null;
  next: { key: string; label: string } | null;   // null for the current week
};

export type StripItem = { key: string; label: string; value: string; qualifier: string; compare: string | null; tooFew: boolean };

export type StatsModel = {
  freshness: Freshness;
  error: PanelError | null;
  role: "helper" | "organizer";
  week: WeekHeader;
  title: string;               // "Statistics: 47 finished in week 42"
  h1: string;                  // "Statistics, week 42 of 2026"
  includeImported: boolean;
  importToggle: { label: string; createdWithout: number; createdWith: number };
  incomplete: string | null;   // "no data: the 1,000-row cap was reached before this week's start"
  empty: string | null;        // "No tickets were created in week 43."
  strip: StripItem[];          // 8 numbers in the mockup's order
  equation: { resolved: number; closed: number; finished: number; closedImportNoAnswer: number; closedOther: number };
  finishedBy: {
    orry: { total: number; lastWord: number; judge: number; historyImport: number; importResolved: number; importClosed: number; live: number };
    people: { total: number; helpers: number; participants: number; personOrMacro: number };
    bar: Array<{ key: FinishedByLabel; label: string; n: number; share: number }>;
    importLine: string;        // "History-import closes 4: 2 resolved, 2 closed with no answer."
    meaning: string;           // the "What this means" paragraph
    exact: boolean;            // true when Orry's closing events (G9) decided every label
    exactNote: string | null;
    ledgerHref: string;        // "/stats/closed?week=2026-W42"
  };
  whoChart: {
    weeks: Array<{ key: string; short: string; total: number; provisional: boolean; parts: Record<FinishedByLabel, number>; four: { helper: number; self: number; orry: number; other: number }; orryPct: number | null }>;
    sentence: string;
    act: string | null;
  };
  flowChart: { weeks: Array<{ key: string; short: string; created: number; finished: number; net: number; provisional: boolean }>; sentence: string };
  heat: {
    weeksLabel: string;        // "Last 4 weeks · UTC, 2-hour blocks"
    cells: Array<{ day: number; dayShort: string; dayLong: string; block: number; blockLabel: string; created: number; neededHuman: number; step: 0 | 1 | 2 | 3 | 4; median: string; p90: string | null; n: number }>;
    total: number;
    busiest: Array<{ label: string; created: number }>;
    slowest: Array<{ label: string; median: string; n: number }>;
    sentence: string;
  };
  categories: { rows: Array<{ key: string; label: string; created: number; firstReply: string; resolution: string; reopened: string; selfResolved: string; countsOnly: boolean; countsOnlyText: string | null }>; all: { created: number; firstReply: string; resolution: string; reopened: string; selfResolved: string }; note: string };
  team: { cohort: string; rows: Array<{ person: PersonRef; finished: number; firstReplies: number; median: string; tooFew: boolean; reopened: string }>; totals: { finished: number; firstReplies: number; median: string; reopened: string }; note: string; rosterEmpty: boolean };
  answers: { state: "needs_update"; message: string };
  more: { noHumanReply: string; noHumanNote: string; notAvailable: string[] };
  counted: Array<{ measure: string; counts: string; n: string; p90: string; typical: string }>;
  notes: string[];
  computed: string;            // "Computed 18 Oct 2026, 14:02 UTC · Orry ticket rows, read-only · ISO weeks in UTC"
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_L = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const pad = (n: number) => String(n).padStart(2, "0");
const blockLabel = (b: number) => `${pad(b * 2)}:00-${pad(b * 2 + 2)}:00`;

export function weekHeader(w: WeekRange, now: number, currentWeek: string): WeekHeader {
  const p = provisional(w, now);
  const partial = now < w.end;
  const prevKey = shiftWeek(w.key, -1), nextKey = shiftWeek(w.key, 1);
  return {
    key: w.key, short: shortWeek(w.key), label: `Week ${w.week}`, span: weekSpanLabel(w), year: w.year,
    partial, provisional: p.provisional, provisionalUntil: p.provisional ? dayMonth(p.until) : null,
    chip: partial ? "This week so far" : p.provisional ? `Provisional until ${dayMonth(p.until)}` : null,
    prev: { key: prevKey, label: shortWeek(prevKey) },
    next: w.key === currentWeek ? null : { key: nextKey, label: nextKey === currentWeek ? `${shortWeek(nextKey)} so far` : shortWeek(nextKey) }
  };
}

function errorStats(s: Session, week: WeekRange, now: number, freshness: Freshness, error: PanelError): StatsModel {
  const hdr = weekHeader(week, now, week.key);
  const z = { helper: 0, participant: 0, orry_last_word: 0, orry_judge: 0, import_resolved: 0, import_closed: 0, person_or_macro: 0 };
  return {
    freshness, error, role: s.role, week: hdr, title: `Statistics, week ${week.week}`, h1: `Statistics, week ${week.week} of ${week.year}`,
    includeImported: false, importToggle: { label: "Include imported tickets", createdWithout: 0, createdWith: 0 }, incomplete: null, empty: null,
    strip: [], equation: { resolved: 0, closed: 0, finished: 0, closedImportNoAnswer: 0, closedOther: 0 },
    finishedBy: { orry: { total: 0, lastWord: 0, judge: 0, historyImport: 0, importResolved: 0, importClosed: 0, live: 0 }, people: { total: 0, helpers: 0, participants: 0, personOrMacro: 0 }, bar: LABEL_ORDER.map(k => ({ key: k, label: LABEL_NAME[k], n: z[k], share: 0 })), importLine: "", meaning: "", exact: false, exactNote: null, ledgerHref: `/stats/closed?week=${week.key}` },
    whoChart: { weeks: [], sentence: "", act: null }, flowChart: { weeks: [], sentence: "" },
    heat: { weeksLabel: "", cells: [], total: 0, busiest: [], slowest: [], sentence: "" },
    categories: { rows: [], all: { created: 0, firstReply: "", resolution: "", reopened: "", selfResolved: "" }, note: "" },
    team: { cohort: "", rows: [], totals: { finished: 0, firstReplies: 0, median: "", reopened: "" }, note: "", rosterEmpty: false },
    answers: { state: "needs_update", message: "Not available yet: needs Orry update G3 (stats route)." },
    more: { noHumanReply: "", noHumanNote: "", notAvailable: [] }, counted: [], notes: [], computed: ""
  };
}

export async function getStatsModel(s: Session, q: { week?: string | null; includeImported?: boolean } = {}, dsIn?: DataSource): Promise<StatsModel> {
  const ds = dsIn ?? getDataSource();
  const inc = !!q.includeImported;
  const r = await loadHistoryCtx(ds, s.role, q.week, inc);
  if (!r.ok) return errorStats(s, r.week, r.now, r.freshness, r.error);
  const v = r.v;
  const w = v.week;
  const hdr = weekHeader(w, v.now, v.currentWeek);
  const cur = rowsOf(v, w);
  const prevW = v.weeks[v.weeks.length - 2];
  const prev = rowsOf(v, prevW);
  const S = weekStats(cur.created, cur.finished, cur.allCreated, v.ctx);
  const SP = weekStats(prev.created, prev.finished, prev.allCreated, v.ctx);
  const weekly = v.weeks.map(x => { const rr = rowsOf(v, x); return { w: x, s: weekStats(rr.created, rr.finished, rr.allCreated, v.ctx) }; });
  const typical = (f: (s: WeekStats) => number | null) => upperMedian(weekly.slice(-9, -1).map(x => f(x.s)));

  const orryPct = pct(S.orry.total, S.finished), orryPctPrev = pct(SP.orry.total, SP.finished);
  const peoplePct = pct(S.people.total, S.finished), peoplePctPrev = pct(SP.people.total, SP.finished);
  const limitText = formatDuration(v.ctx.limitMs, { nbsp: false });
  const strip: StripItem[] = [
    { key: "finished", label: "Finished", value: String(S.finished), qualifier: `${S.resolved} resolved + ${S.closed} closed`, compare: compareCount(S.finished, SP.finished), tooFew: false },
    { key: "orry", label: "Finished by Orry", value: String(S.orry.total), qualifier: `${pctText(orryPct)} of ${S.finished}`, compare: comparePct(orryPct, orryPctPrev), tooFew: false },
    { key: "people", label: "Finished by people", value: String(S.people.total), qualifier: `${pctText(peoplePct)} of ${S.finished}`, compare: comparePct(peoplePct, peoplePctPrev), tooFew: false },
    { key: "created", label: "Created", value: String(S.created), qualifier: inc ? `including ${S.createdImported} imported tickets` : "new tickets", compare: compareCount(S.created, SP.created), tooFew: false },
    { key: "first_reply", label: "First human reply", value: durOrFew(S.firstReply.median, S.firstReply.n, S.firstReply.tooFew), qualifier: "median", compare: S.firstReply.tooFew ? null : compareDuration(S.firstReply.median, SP.firstReply.median), tooFew: S.firstReply.tooFew },
    { key: "resolution", label: "Time to resolution", value: durOrFew(S.resolution.median, S.resolution.n, S.resolution.tooFew), qualifier: "median", compare: S.resolution.tooFew ? null : compareDuration(S.resolution.median, SP.resolution.median), tooFew: S.resolution.tooFew },
    { key: "reopened", label: "Reopened", value: pctText(S.reopened.pct), qualifier: `${S.reopened.n} of ${S.reopened.of}`, compare: comparePct(S.reopened.pct, SP.reopened.pct), tooFew: false },
    { key: "within", label: `Within ${limitText} limit`, value: pctText(S.within.pct), qualifier: `${S.within.within} of ${S.within.of}`, compare: comparePct(S.within.pct, SP.within.pct), tooFew: false }
  ];

  const bar = LABEL_ORDER.map(k => ({ key: k, label: LABEL_NAME[k], n: S.labels[k], share: S.finished ? Math.round((S.labels[k] / S.finished) * 100) : 0 }));
  const imp = S.orry.importResolved + S.orry.importClosed;
  const meaning = S.finished === 0 ? "Nothing finished in this week." :
    `Orry closed ${S.orry.total} of the ${S.finished} tickets that finished in week ${w.week}${imp ? `, ${imp} of them through the history import` : ""}. ` +
    `${S.orry.lastWord} used the last-word rule: a helper answered last and the participant did not come back for 2 days, so Orry marked the ticket resolved. ` +
    `${S.orry.judge} ${S.orry.judge === 1 ? "was" : "were"} closed by Orry's judge after it read the thread and found clear evidence the problem was solved. ` +
    "None of these counts tickets Orry answered on its own: Orry does not record its own answers on tickets yet (needs Orry update G13).";

  // who finished, last 8 weeks
  const who = weekly.slice(-8).map(({ w: x, s: ws }) => ({
    key: x.key, short: shortWeek(x.key), total: ws.finished, provisional: provisional(x, v.now).provisional, parts: ws.labels,
    four: { helper: ws.labels.helper, self: ws.labels.participant, orry: ws.orry.total, other: ws.labels.person_or_macro },
    orryPct: pct(ws.orry.total, ws.finished)
  }));
  const whoSentence = `Orry finished ${pctText(orryPct)} this week and ${pctText(orryPctPrev)} the week before.`;
  const act = S.closedImportNoAnswer || SP.closedImportNoAnswer ? `${S.closedImportNoAnswer} of ${S.finished} closed with no answer this week, ${S.closedImportNoAnswer > SP.closedImportNoAnswer ? "up from" : S.closedImportNoAnswer < SP.closedImportNoAnswer ? "down from" : "the same as"} ${SP.closedImportNoAnswer}.` : null;

  const flow = weekly.map(({ w: x, s: ws }) => ({ key: x.key, short: shortWeek(x.key), created: ws.created, finished: ws.finished, net: ws.created - ws.finished, provisional: provisional(x, v.now).provisional }));
  const last6 = flow.slice(-6), beat = last6.filter(f => f.created > f.finished).length;
  const flowSentence = `Created beat finished in ${beat} of the last ${last6.length} weeks. They are different groups of tickets, so the gap is not the queue.`;

  // waiting grid, last 4 weeks
  const last4 = v.weeks.slice(-4);
  const created4 = last4.flatMap(x => rowsOf(v, x).created);
  const cells = heatmap(created4).map(c => ({
    day: c.day, dayShort: DAYS[c.day], dayLong: DAYS_L[c.day], block: c.block, blockLabel: blockLabel(c.block), created: c.created, neededHuman: c.neededHuman,
    step: heatStep(c.created), n: c.firstReply.n, median: durOrFewShort(c.firstReply.median, c.firstReply.n, c.firstReply.tooFew), p90: c.firstReply.tooFew ? null : formatDuration(c.firstReply.p90!)
  }));
  const busiest = [...cells].sort((a, b) => b.created - a.created || a.day - b.day || a.block - b.block).slice(0, 5);
  const raw = heatmap(created4);
  const slowestRaw = raw.filter(c => !c.firstReply.tooFew).sort((a, b) => (b.firstReply.median ?? 0) - (a.firstReply.median ?? 0)).slice(0, 5);
  const topN = busiest[0]?.created ?? 0, ties = cells.filter(c => c.created === topN && topN > 0);
  const heatSentence = topN === 0 ? "No tickets were created in these 4 weeks." :
    `Busiest: ${ties[0].dayShort} ${ties[0].blockLabel}${ties.length > 1 ? ` and ${ties.length - 1} more block${ties.length > 2 ? "s" : ""}` : ""} (${topN} tickets${ties.length > 1 ? " each" : ""}).` +
    (slowestRaw[0] ? ` Slowest median: ${DAYS[slowestRaw[0].day]} ${blockLabel(slowestRaw[0].block)}, ${formatDuration(slowestRaw[0].firstReply.median!)}.` : "") + " All UTC.";

  // categories
  const catRows = byCategory(cur.created, cur.finished, v.ctx).map(c => ({
    key: c.category, label: categoryLabel(c.category), created: c.created,
    firstReply: durOrFewShort(c.firstReply.median, c.firstReply.n, c.firstReply.tooFew), resolution: durOrFewShort(c.resolution.median, c.resolution.n, c.resolution.tooFew),
    reopened: `${c.reopened} of ${c.created}`, selfResolved: `${c.selfResolved} of ${c.created}`, countsOnly: c.countsOnly,
    countsOnlyText: c.countsOnly ? `Too few tickets (n = ${c.created}). Counts only: reopened ${c.reopened}, self-resolved ${c.selfResolved}.` : null
  }));
  const allSelf = catRows.reduce((a, c) => a + Number(c.selfResolved.split(" ")[0]), 0);

  // team (names, sorted by name; no ranks)
  const active = activePeople(v, cur.created, cur.finished);
  const people = await resolvePeople([...active, s.slackId], { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (id: string) => people.get(id) ?? personRef(id, null, s.slackId);
  const teamRows = active.map(id => {
    const m = personMeasures(id, cur.created, cur.finished, v.ctx);
    return { person: P(id), finished: m.finished, firstReplies: m.firstReplies, median: durOrFewShort(m.firstReply.median, m.firstReplies, m.firstReply.tooFew), tooFew: m.firstReply.tooFew, reopened: `${m.reopened} of ${m.firstReplies}` };
  }).sort((a, b) => a.person.label.localeCompare(b.person.label));
  const tt = teamTotals(cur.created, cur.finished, v.ctx);

  const fresh = v.freshness;
  const computedAt = fresh.at ? Date.parse(fresh.at) : v.now;
  const d = new Date(computedAt);
  const notes = [
    "Medians are upper medians, as Orry computes them. They are hidden when n is under 5.",
    ...(hdr.partial ? [`Week ${w.week} is not over yet: these are the numbers so far.`] : []),
    ...(hdr.provisional ? [`Week ${w.week} is provisional: Orry can still close tickets in it until ${hdr.provisionalUntil}.`] : []),
    "\"Finished by Orry\" is not \"solved by Orry\". Orry does not record its own answers yet, and auto-resolves are dated to the last message, so one closed on Wednesday can land in last week."
  ];
  if (v.roster.ids.size === 0) notes.push("Empty because Loadout's helper roster is empty: first human reply, the limit and the team need it.");

  return {
    freshness: fresh, error: null, role: s.role, week: hdr,
    title: `Statistics: ${S.finished} finished in week ${w.week}`, h1: `Statistics, week ${w.week} of ${w.year}`,
    includeImported: inc,
    importToggle: { label: "Include imported tickets", createdWithout: rowsOf(v, w, { ...v.ctx, includeImported: false }).created.length, createdWith: cur.allCreated.length },
    incomplete: v.h.incomplete.get(w.start) ? `No data: ${v.h.incomplete.get(w.start)}.` : null,
    empty: S.created === 0 && S.finished === 0 ? `No tickets were created in week ${w.week}.` : null,
    strip,
    equation: { resolved: S.resolved, closed: S.closed, finished: S.finished, closedImportNoAnswer: S.closedImportNoAnswer, closedOther: S.closedOther },
    finishedBy: {
      orry: { total: S.orry.total, lastWord: S.orry.lastWord, judge: S.orry.judge, historyImport: imp, importResolved: S.orry.importResolved, importClosed: S.orry.importClosed, live: S.orry.live },
      people: S.people, bar,
      importLine: `History-import closes ${imp}: ${S.orry.importResolved} resolved, ${S.orry.importClosed} closed with no answer.`,
      meaning, exact: S.sourceExact,
      exactNote: S.sourceExact ? null : "Orry, last-word rule and Orry, judge may include history-import closes (read from the ticket rows; Orry's closing events are not available).",
      ledgerHref: `/stats/closed?week=${w.key}`
    },
    whoChart: { weeks: who, sentence: whoSentence, act },
    flowChart: { weeks: flow, sentence: flowSentence },
    heat: {
      weeksLabel: "Last 4 weeks · UTC, 2-hour blocks", cells, total: created4.length,
      busiest: busiest.map(c => ({ label: `${c.dayShort} ${c.blockLabel}`, created: c.created })),
      slowest: slowestRaw.map(c => ({ label: `${DAYS[c.day]} ${blockLabel(c.block)}`, median: formatDuration(c.firstReply.median!), n: c.firstReply.n })),
      sentence: heatSentence
    },
    categories: {
      rows: catRows,
      all: { created: S.created, firstReply: durOrFewShort(S.firstReply.median, S.firstReply.n, S.firstReply.tooFew), resolution: durOrFewShort(S.resolution.median, S.resolution.n, S.resolution.tooFew), reopened: `${S.reopened.n} of ${S.reopened.of}`, selfResolved: `${allSelf} of ${S.created}` },
      note: `Week ${w.week} · the category is Orry's keyword guess`
    },
    team: {
      cohort: `Week ${w.week} · every person on the roster with tickets this week`, rows: teamRows,
      totals: { finished: tt.finished, firstReplies: tt.firstReplies, median: durOrFewShort(tt.firstReplyMedian, tt.firstReplies, tt.firstReplyTooFew), reopened: `${tt.reopened} of ${tt.firstReplies}` },
      note: "Sorted by name. Ranks are on the Leaderboard; your own numbers are on My stats.", rosterEmpty: v.roster.ids.size === 0
    },
    answers: { state: "needs_update", message: "Not available yet: needs Orry update G3 (stats route)." },
    more: {
      noHumanReply: `Finished with no human reply: ${S.noHumanReply.n} of ${S.noHumanReply.of} (${pctText(S.noHumanReply.pct)})`,
      noHumanNote: "Includes participants who resolved it themselves and Orry's auto-resolves.",
      notAvailable: ["Escalation rate, time to claim, and Orry answering before a human: not available yet. Orry does not record them."]
    },
    counted: [
      { measure: "Finished", counts: `Resolved or closed in week ${w.week}, including tickets Orry closed.`, n: String(S.finished), p90: "–", typical: fmtN(typical(x => x.finished)) },
      { measure: "Finished by Orry", counts: `Last-word rule ${S.orry.lastWord}, judge ${S.orry.judge}, history import ${imp}.`, n: String(S.finished), p90: "–", typical: fmtN(typical(x => x.orry.total)) },
      { measure: "Finished by people", counts: `Helpers ${S.people.helpers}, participants ${S.people.participants}, a person or macro ${S.people.personOrMacro}.`, n: String(S.finished), p90: "–", typical: fmtN(typical(x => x.people.total)) },
      { measure: "Created", counts: `Tickets created in week ${w.week}.`, n: String(S.created), p90: "–", typical: fmtN(typical(x => x.created)) },
      { measure: "First human reply", counts: `Created in week ${w.week} to the first reply by a helper or organizer. Orry's status message never counts.`, n: `${S.firstReply.n} of ${S.created}`, p90: S.firstReply.tooFew ? "–" : formatDuration(S.firstReply.p90!), typical: fmtD(typical(x => x.firstReply.median)) },
      { measure: "Time to resolution", counts: "Created to resolved, for tickets finished this week. Closed tickets are left out.", n: String(S.resolution.n), p90: S.resolution.tooFew ? "–" : formatDuration(S.resolution.p90!), typical: fmtD(typical(x => x.resolution.median)) },
      { measure: "Reopened", counts: `Created in week ${w.week} and reopened at least once. A maturing rate.`, n: String(S.reopened.of), p90: "–", typical: pctText(typical(x => x.reopened.pct)) },
      { measure: `Within the ${limitText} limit`, counts: `Tickets that needed a human: first human reply, or finished, within ${limitText}. ${S.within.stillInside} still inside the limit are left out. The limit is a site setting.`, n: String(S.within.of), p90: "–", typical: pctText(typical(x => x.within.pct)) }
    ],
    notes,
    computed: `Computed ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hhmm(computedAt)} UTC · Orry ticket rows, read-only · ISO weeks in UTC`
  };
}

const fmtN = (n: number | null) => (n == null ? "–" : String(n));
const fmtD = (n: number | null) => (n == null ? "–" : formatDuration(n));

export { MIN, MIN_N };
