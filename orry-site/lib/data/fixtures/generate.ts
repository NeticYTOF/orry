/* The deterministic fixture generator (ORRY_FIXTURES=1). Invented tickets over 12 ISO weeks (W31-W42 of 2026), built
   so the pages reproduce the mockups' week 42 (reports/orry-site-plan-2026-10-19/mockups/earlier-drafts/*.html):
   47 finished = 41 resolved + 6 closed; by Orry 17 (last-word 9, judge 4, history import 4); helpers 19 (6,4,3,3,2,1);
   participants 7; a person or macro 4; 52 created; the board's 7 / 3 / 5 h 12 min (#1042) / over the limit 2.
   Weekly created and finished counts follow the mockup's 12-week series; the helpers' per-week finished counts follow
   the Leaderboard matrix. Everything is invented. Same seed and same "now", same data. */
import type { ClosingInfo, FinishedByLabel, Person, TicketNote, TicketRow } from "../types";
import { rng, type Rng } from "../prng";
import { TicketBuilder, resetSeqs, type RawEvent } from "./builder";
import { TEXTS, participants, type Category } from "./texts";
import { DEFAULT_FIXTURE_NOW } from "../clock";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const H = { P: "U0JUNO001", C: "U0LEILA01", D: "U0RAVI001", F: "U0MIA0001", S: "U0ZARA001", N: "U0NOAH001" } as const;
export const PAT = "U0PAT0001";
export const HELP_CHANNEL = "C0LOADHLP1";
export const BUILD_CHANNEL = "C0LOADBLD2";
const HK = ["P", "C", "D", "F", "S", "N"] as const;
type HKey = (typeof HK)[number];

export type FixtureData = {
  now: number;
  tickets: TicketRow[];
  events: Map<number, RawEvent[]>;
  notes: Map<number, TicketNote[]>;
  closings: Map<number, ClosingInfo>;
  participants: Person[];
};

/* ---------- the mockups' series ---------- */
const WEEKS = [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
const CREATED: Record<number, number> = { 31: 31, 32: 38, 33: 44, 34: 41, 35: 36, 36: 29, 37: 47, 38: 55, 39: 49, 40: 58, 41: 61, 42: 52 };
/* tickets created in week w that finish in w (a), in w+1 (b), or stay open or parked (e). Solved so that
   created = a + b + e and finished(w) = a(w) + b(w-1) for every week. */
const A: Record<number, number> = { 31: 27, 32: 30, 33: 32, 34: 35, 35: 32, 36: 27, 37: 37, 38: 46, 39: 47, 40: 49, 41: 53 };
const B: Record<number, number> = { 31: 4, 32: 8, 33: 10, 34: 6, 35: 4, 36: 2, 37: 4, 38: 6, 39: 2, 40: 5, 41: 8 };
const E: Record<number, number> = { 33: 2, 37: 6, 38: 3, 40: 4 };
/* finish week → [helper, participant, last word, judge, import resolved, import closed, person or macro] (W35-W42 from stats.html) */
const WHO: Record<number, number[]> = {
  31: [12, 4, 6, 2, 1, 0, 2], 32: [15, 5, 7, 3, 1, 1, 2], 33: [17, 6, 9, 3, 1, 1, 3], 34: [19, 7, 10, 4, 1, 1, 3],
  35: [17, 6, 7, 2, 2, 1, 3], 36: [14, 5, 6, 2, 1, 1, 2], 37: [18, 6, 7, 3, 1, 1, 3], 38: [24, 8, 9, 3, 2, 1, 3],
  39: [25, 8, 10, 4, 2, 1, 3], 40: [23, 7, 11, 4, 1, 2, 3], 41: [26, 9, 12, 4, 2, 2, 3]
};
const LABELS: FinishedByLabel[] = ["helper", "participant", "orry_last_word", "orry_judge", "import_resolved", "import_closed", "person_or_macro"];
/* finish week → helper credits [P, C, D, F, S, N] (W35-W41 from leaderboard.html) */
const FIN: Record<number, number[]> = {
  31: [3, 3, 2, 2, 1, 1], 32: [4, 3, 3, 2, 2, 1], 33: [4, 4, 3, 3, 2, 1], 34: [5, 4, 3, 3, 3, 1],
  35: [4, 3, 3, 3, 2, 2], 36: [3, 3, 2, 3, 2, 1], 37: [4, 4, 3, 3, 3, 1], 38: [6, 5, 4, 4, 3, 2],
  39: [6, 5, 5, 4, 3, 2], 40: [5, 5, 4, 4, 3, 2], 41: [7, 6, 5, 4, 3, 1]
};
/* weeks 35-42, created cohort: first replies, upper-median first reply (min), reopened, per person (leaderboard.html W8) */
const W8_FR: Record<HKey, number> = { P: 71, C: 58, D: 47, F: 52, S: 40, N: 14 };
const W8_MED: Record<HKey, number> = { P: 29, C: 35, D: 41, F: 65, S: 49, N: 90 };
const W8_RE: Record<HKey, number> = { P: 7, C: 6, D: 3, F: 6, S: 5, N: 2 };
/* week 42 first-reply lags per person (minutes), chosen so the person medians are 26, 24, 44, 72, 52 (and too few
   for N), the team median is 38 min and the team p90 is 4 h 10 min over 41 replies. */
const W42_LAGS: Record<HKey, number[]> = {
  P: [6, 9, 14, 18, 22, 26, 31, 40, 55, 95, 260],
  C: [5, 8, 12, 19, 24, 29, 38, 70, 150],
  D: [20, 33, 37, 44, 61, 300],
  F: [25, 41, 58, 72, 110, 250, 420],
  S: [16, 30, 45, 52, 90, 380],
  N: [36, 140]
};
/* the 2-hour-block shape of when tickets are created (stats.html wait grid), used as sampling weights */
const GRID = [
  [1, 0, 1, 0, 1, 2, 3, 4, 6, 4, 3, 2], [2, 1, 1, 0, 1, 2, 3, 3, 4, 6, 3, 2], [1, 1, 0, 1, 1, 2, 3, 5, 4, 4, 3, 2], [1, 0, 1, 0, 1, 2, 2, 4, 6, 4, 3, 1],
  [1, 1, 0, 0, 1, 2, 3, 3, 5, 6, 4, 3], [2, 1, 1, 1, 1, 3, 4, 5, 7, 7, 6, 3], [2, 2, 1, 1, 2, 3, 4, 6, 7, 6, 5, 4]
];
const CELL_W = GRID.flat().map(v => v + 0.3);
const CAT_W: Array<[Category, number]> = [["review", 27], ["advice_how_to", 25], ["other", 21], ["site_bug", 13], ["fulfillment_shipping", 8], ["account_access", 6]];

const REASONS = ["The participant said it works now.", "The thread shows the fix was applied.", "The requester confirmed the steps worked."];
const NOTES = ["Asked for a screen recording. Waiting on the requester.", "Same issue as last week. The fix is in the docs.", "Checked the order list. Nothing missing."];

/** ISO week w of 2026: Monday 00:00 UTC. */
const weekStartOf = (w: number) => Date.UTC(2025, 11, 29) + (w - 1) * 7 * DAY;

type Plan = {
  week: number;
  created: number;
  finish: number | null;
  label: FinishedByLabel | null;
  credit: HKey | null;
  fr: HKey | null;
  lag: number | null;              // minutes
  reopen: boolean;
  category: Category;
  extra?: "open" | "duplicate" | "snoozed";
  macro?: boolean;
  text?: string;
  visibility?: "thread" | "dashboard";
  sensitiveText?: boolean;
};

export function generateFixtures(o: { now?: number; seed?: number } = {}): FixtureData {
  /* The data are built for the default instant and then shifted, so ORRY_NOW moves every time and keeps the shape. */
  const baseNow = DEFAULT_FIXTURE_NOW;
  const now = o.now ?? baseNow;
  const shift = now - baseNow;
  const R = rng(o.seed ?? 42042);
  resetSeqs();
  const people = participants(140);
  let pi = 0;
  const nextReq = () => people[(pi++ * 13) % people.length].id;
  const named = new Map<string, string>();
  const req = (handle: string) => {
    let id = named.get(handle);
    if (!id) { id = `U0RB${String(named.size + 1).padStart(5, "0")}`; named.set(handle, id); }
    return id;
  };
  const textIdx: Record<string, number> = {};
  const textFor = (c: Category) => { const pool = TEXTS[c]; const i = (textIdx[c] = ((textIdx[c] ?? -1) + 1)) % pool.length; return pool[(i * 3 + c.length) % pool.length]; };
  const pickCat = () => CAT_W[R.weighted(CAT_W.map(x => x[1]))][0];

  const sampleIn = (start: number, lo: number, hi: number): number => {
    for (let t = 0; t < 40; t++) {
      const cell = R.weighted(CELL_W);
      const d = Math.floor(cell / 12), b = cell % 12;
      const at = start + d * DAY + b * 2 * HOUR + Math.floor(R() * 120) * MIN + R.int(0, 59) * 1000;
      if (at >= lo && at <= hi) return at;
    }
    return lo + Math.floor(R() * Math.max(1, hi - lo));
  };
  const ttrSample = (median = 360) => Math.max(18, Math.round(median * Math.exp((R() + R() + R() - 1.5) * 1.3))) * MIN;
  const lagSample = (median = 45) => Math.max(2, Math.round(median * Math.exp((R() + R() + R() - 1.5) * 1.4)));

  const plans: Plan[] = [];

  /* ---------- weeks 31-41: plans from the series ---------- */
  for (const w of WEEKS.slice(0, 11)) {
    const ws = weekStartOf(w), we = ws + 7 * DAY;
    // finishers in week w: a(w) created this week, b(w-1) created last week
    const aPlans: Plan[] = [];
    for (let i = 0; i < A[w]; i++) {
      const created = sampleIn(ws, ws, we - 3 * HOUR);
      const room = we - 60_000 - created;
      const ttr = Math.min(ttrSample(), Math.max(20 * MIN, room * (0.3 + 0.6 * R())));
      aPlans.push({ week: w, created, finish: created + ttr, label: null, credit: null, fr: null, lag: null, reopen: false, category: pickCat() });
    }
    const bPrev = plans.filter(p => p.week === w - 1 && p.finish === -1);
    const finishers = [...bPrev, ...aPlans];
    // labels: import closes need a thread at least 7 days old, so they go to last week's tickets first
    const counts = [...WHO[w]];
    const pool: FinishedByLabel[] = [];
    counts.forEach((n, i) => { for (let k = 0; k < n; k++) pool.push(LABELS[i]); });
    const impClosed = pool.filter(l => l === "import_closed");
    const rest = R.shuffle(pool.filter(l => l !== "import_closed"));
    bPrev.forEach((p, i) => { p.label = i < impClosed.length ? "import_closed" : rest.pop()!; });
    aPlans.forEach(p => { p.label = rest.pop()!; });
    // finish times for last week's tickets
    for (const p of bPrev) {
      if (p.label === "import_closed") p.finish = Math.max(p.created + 7 * DAY + R.int(10, 600) * MIN, ws + R.int(30, 600) * MIN);
      else p.finish = ws + R.int(20, 3 * 24 * 60) * MIN;
      if (p.finish >= we) p.finish = we - R.int(5, 120) * MIN;
    }
    // helper credits
    const credits: HKey[] = [];
    FIN[w].forEach((n, i) => { for (let k = 0; k < n; k++) credits.push(HK[i]); });
    R.shuffle(credits);
    for (const p of finishers) if (p.label === "helper") p.credit = credits.pop()!;
    for (const p of finishers) if (p.label === "person_or_macro") p.macro = R() < 0.5;
    plans.push(...aPlans);
    // tickets created this week that finish next week
    for (let i = 0; i < B[w]; i++) {
      const early = i < 2; // the first two can become history-import closes next week
      const created = early ? ws + R.int(0, 36 * 60) * MIN : sampleIn(ws, ws + 4 * DAY, we - HOUR);
      plans.push({ week: w, created, finish: -1, label: null, credit: null, fr: null, lag: null, reopen: false, category: pickCat() });
    }
    // tickets that stay open or parked
    for (let i = 0; i < (E[w] ?? 0); i++) {
      const created = sampleIn(ws, ws, we - HOUR);
      const extra = i % 5 === 1 ? "duplicate" : i === 3 && w === 37 ? "snoozed" : "open";
      plans.push({ week: w, created, finish: null, label: null, credit: null, fr: null, lag: null, reopen: false, category: pickCat(), extra });
    }
  }

  /* ---------- week 41 tickets that finish in week 42 (8): fixed ---------- */
  const w41 = weekStartOf(41), w42 = weekStartOf(42), NOW = baseNow;
  const b41 = plans.filter(p => p.week === 41 && p.finish === -1).sort((a, b) => a.created - b.created);
  const b41spec: Array<{ label: FinishedByLabel; credit?: HKey; created: number; ttr?: number; finishAt?: number; cat: Category }> = [
    { label: "import_closed", created: w41 + 9 * HOUR + 12 * MIN, finishAt: w42 + DAY + 3 * HOUR + 40 * MIN, cat: "other" },
    { label: "import_closed", created: w41 + DAY + 15 * HOUR + 5 * MIN, finishAt: w42 + 2 * DAY + 3 * HOUR + 40 * MIN, cat: "fulfillment_shipping" },
    { label: "import_resolved", created: w41 + 3 * DAY + 10 * HOUR, ttr: 5800, cat: "review" },
    { label: "import_resolved", created: w41 + 4 * DAY + 11 * HOUR + 20 * MIN, ttr: 4600, cat: "advice_how_to" },
    { label: "orry_last_word", created: w41 + 5 * DAY + 8 * HOUR, ttr: 3900, cat: "site_bug" },
    { label: "orry_last_word", created: w41 + 5 * DAY + 20 * HOUR, ttr: 3400, cat: "advice_how_to" },
    { label: "helper", credit: "P", created: w41 + 6 * DAY + 6 * HOUR, ttr: 3060, cat: "review" },
    { label: "helper", credit: "C", created: w41 + 6 * DAY + 12 * HOUR, ttr: 2700, cat: "other" }
  ];
  b41.forEach((p, i) => {
    const s = b41spec[i];
    p.label = s.label; p.credit = s.credit ?? null; p.created = s.created; p.category = s.cat;
    p.finish = s.finishAt ?? s.created + (s.ttr ?? 0) * MIN;
    p.week = 41;
  });

  /* ---------- week 42: 39 created and finished this week, fixed ---------- */
  type W42Spec = { label: FinishedByLabel; credit?: HKey; fr?: HKey; lag?: number; reopen?: boolean; cat?: Category; macro?: boolean; sensitive?: boolean };
  const w42spec: W42Spec[] = [
    // helpers 17: P5 C3 D3 F3 S2 N1, first reply by the credited helper
    { label: "helper", credit: "P", fr: "P", lag: 6 }, { label: "helper", credit: "P", fr: "P", lag: 14 },
    { label: "helper", credit: "P", fr: "P", lag: 22, reopen: true, cat: "review" }, { label: "helper", credit: "P", fr: "P", lag: 31 },
    { label: "helper", credit: "P", fr: "P", lag: 55 },
    { label: "helper", credit: "C", fr: "C", lag: 5 }, { label: "helper", credit: "C", fr: "C", lag: 24, cat: "other", sensitive: true },
    { label: "helper", credit: "C", fr: "C", lag: 70 },
    { label: "helper", credit: "D", fr: "D", lag: 20 }, { label: "helper", credit: "D", fr: "D", lag: 37 }, { label: "helper", credit: "D", fr: "D", lag: 61 },
    { label: "helper", credit: "F", fr: "F", lag: 25 }, { label: "helper", credit: "F", fr: "F", lag: 58 }, { label: "helper", credit: "F", fr: "F", lag: 110 },
    { label: "helper", credit: "S", fr: "S", lag: 45 }, { label: "helper", credit: "S", fr: "S", lag: 90 },
    { label: "helper", credit: "N", fr: "N", lag: 36 },
    // last-word rule 7
    { label: "orry_last_word", fr: "P", lag: 9 }, { label: "orry_last_word", fr: "P", lag: 26 }, { label: "orry_last_word", fr: "P", lag: 260 },
    { label: "orry_last_word", fr: "C", lag: 19 }, { label: "orry_last_word", fr: "D", lag: 33 },
    { label: "orry_last_word", fr: "F", lag: 72, reopen: true, cat: "other" }, { label: "orry_last_word", fr: "F", lag: 420 },
    // participants 7 (category split from the category table)
    { label: "participant", fr: "P", lag: 18, cat: "review" }, { label: "participant", fr: "P", lag: 40, cat: "advice_how_to" },
    { label: "participant", fr: "C", lag: 8, cat: "advice_how_to" }, { label: "participant", fr: "C", lag: 150, cat: "advice_how_to" },
    { label: "participant", fr: "F", lag: 41, cat: "other" }, { label: "participant", fr: "S", lag: 52, cat: "other" },
    { label: "participant", fr: "N", lag: 140, cat: "fulfillment_shipping" },
    // judge 4 (one with no human reply)
    { label: "orry_judge", fr: "P", lag: 95 }, { label: "orry_judge", fr: "D", lag: 44 }, { label: "orry_judge", fr: "F", lag: 250 },
    { label: "orry_judge" },
    // a person or a macro 4 (Pat Placeholder): two by hand, two macro duplicates (one with no human reply)
    { label: "person_or_macro", fr: "C", lag: 38, macro: false }, { label: "person_or_macro", fr: "D", lag: 300, macro: false },
    { label: "person_or_macro", fr: "S", lag: 380, macro: true }, { label: "person_or_macro", macro: true }
  ];
  // categories for the 39: review 9, how-to 12, other 8, site bug 5, shipping 3, account 2 (with the board, 52 created)
  const catLeft: Record<Category, number> = { review: 9, advice_how_to: 12, other: 8, site_bug: 5, fulfillment_shipping: 3, account_access: 2 };
  for (const s of w42spec) if (s.cat) catLeft[s.cat]--;
  const catPool: Category[] = [];
  (Object.keys(catLeft) as Category[]).forEach(c => { for (let i = 0; i < catLeft[c]; i++) catPool.push(c); });
  R.shuffle(catPool);
  for (const s of w42spec) if (!s.cat) s.cat = catPool.pop()!;
  // time to resolution for the 35 resolved: paired with the first-reply lag (longer reply, longer resolution)
  const TTR42 = [48, 62, 75, 88, 95, 110, 125, 140, 160, 175, 190, 210, 230, 250, 270, 290, 310, 330, 345, 355, 365, 390, 420, 460, 520, 600, 700, 820, 960, 1100, 1300, 1500, 1750, 2000, 2300];
  const resolved42 = w42spec.filter(s => s.label !== "person_or_macro").sort((a, b) => (a.lag ?? 0) - (b.lag ?? 0));
  const ttrOf = new Map<W42Spec, number>();
  resolved42.forEach((s, i) => ttrOf.set(s, TTR42[i]));
  for (const s of w42spec) {
    const ttr = ttrOf.get(s);
    let created: number, finish: number;
    if (ttr != null) {
      const latest = (s.label === "orry_last_word" ? NOW - 48 * HOUR - 60 * MIN : NOW - 2 * HOUR) - ttr * MIN;
      created = sampleIn(w42, w42 + 5 * MIN, latest);
      finish = created + ttr * MIN;
    } else {
      created = sampleIn(w42, w42 + 5 * MIN, NOW - ((s.lag ?? 0) + 320) * MIN);
      finish = created + ((s.lag ?? 0) + R.int(40, 300)) * MIN;
    }
    plans.push({
      week: 42, created, finish, label: s.label, credit: s.credit ?? null, fr: s.fr ?? null, lag: s.lag ?? null,
      reopen: !!s.reopen, category: s.cat!, macro: s.macro, sensitiveText: s.sensitive
    });
  }

  /* ---------- first replies for weeks 31-41 ---------- */
  const replyProb: Record<FinishedByLabel, number> = { helper: 1, orry_last_word: 1, participant: 0.7, orry_judge: 0.45, import_resolved: 0.3, import_closed: 0, person_or_macro: 0.5 };
  const early = plans.filter(p => p.week >= 31 && p.week <= 34);
  for (const p of early) {
    if (p.label === "helper") p.fr = p.credit;
    else if (p.label && R() < replyProb[p.label]) p.fr = HK[R.weighted([22, 18, 15, 16, 12, 5])];
  }
  // weeks 35-41: hit the 8-week first-reply counts exactly (W8 minus week 42)
  const mid = plans.filter(p => p.week >= 35 && p.week <= 41);
  const slots: Record<HKey, number> = { P: 0, C: 0, D: 0, F: 0, S: 0, N: 0 };
  for (const k of HK) slots[k] = W8_FR[k] - W42_LAGS[k].length;
  for (const p of mid) if (p.label === "helper") { p.fr = p.credit; slots[p.credit!]--; }
  const must = R.shuffle(mid.filter(p => p.label === "orry_last_word"));
  const flex = R.shuffle(mid.filter(p => p.label === "participant" || p.label === "orry_judge" || p.label === "person_or_macro" || p.label === "import_resolved"));
  const takeSlot = (): HKey | null => {
    let best: HKey | null = null;
    for (const k of HK) if (slots[k] > 0 && (best === null || slots[k] > slots[best])) best = k;
    if (best) slots[best]--;
    return best;
  };
  for (const p of must) p.fr = takeSlot() ?? HK[R.weighted([22, 18, 15, 16, 12, 5])];
  for (const p of flex) { if (HK.every(k => slots[k] <= 0)) break; p.fr = takeSlot(); }

  /* ---------- lags ---------- */
  for (const p of early) if (p.fr) p.lag = lagSample(45);
  for (const k of HK) {
    const mine = mid.filter(p => p.fr === k);
    const lags = lagsWithMedian(R, W42_LAGS[k], W42_LAGS[k].length + mine.length, W8_MED[k]);
    // pair sorted lags with sorted room (finish - created) so every reply comes before the finish
    const room = (p: Plan) => (p.finish && p.finish > 0 ? (p.finish - p.created) / MIN : 1e9);
    const byRoom = [...mine].sort((a, b) => room(a) - room(b));
    lags.sort((a, b) => a - b);
    byRoom.forEach((p, i) => { p.lag = Math.min(lags[i], Math.max(2, Math.floor(room(p) * 0.8))); });
  }

  /* ---------- reopens ---------- */
  const reLeft: Record<HKey, number> = { P: 0, C: 0, D: 0, F: 0, S: 0, N: 0 };
  for (const k of HK) reLeft[k] = W8_RE[k] - (k === "P" || k === "C" || k === "F" || k === "S" ? 1 : 0);
  for (const p of R.shuffle(mid.filter(p => p.fr && p.finish && p.finish > 0 && (p.label === "helper" || p.label === "orry_last_word" || p.label === "participant") && p.finish - p.created > 3 * HOUR && p.week === weekOfPlanFinish(p)))) {
    if (reLeft[p.fr!] > 0) { reLeft[p.fr!]--; p.reopen = true; }
  }
  for (const p of early) if (p.finish && p.finish > 0 && p.label === "helper" && R() < 0.06 && p.finish - p.created > 3 * HOUR) p.reopen = true;

  /* ---------- texts ---------- */
  for (const p of plans) p.text = p.sensitiveText ? "Can I talk to a real person about something that happened in my team?" : textFor(p.category);

  /* ---------- ids: newest first, below the board's fixed numbers ---------- */
  const RESERVED = new Set([981, 986, 990, 994, 997, 1002, 1031, 1036, 1039, 1040, 1042, 1044, 1045, 1047, 1048, 1049, 1050, 1051, 1053, 1054]);
  const importedW42: Plan[] = [];
  for (let i = 0; i < 3; i++) {
    const created = w42 + i * 2 * DAY + R.int(8, 20) * HOUR;
    importedW42.push({ week: 42, created, finish: created + R.int(6, 20) * HOUR, label: "import_resolved", credit: null, fr: null, lag: null, reopen: false, category: pickCat(), visibility: "dashboard" });
  }
  for (const p of importedW42) p.text = ["thanks, that fixed it", "never mind, found it", "ok it works now"][importedW42.indexOf(p)];
  const all = [...plans, ...importedW42].sort((a, b) => b.created - a.created);
  let nextId = 1052;
  const ids = new Map<Plan, number>();
  for (const p of all) { while (RESERVED.has(nextId)) nextId--; ids.set(p, nextId--); }

  /* ---------- build ---------- */
  const out: TicketBuilder[] = [];
  const helperOf = (k: HKey | null) => (k ? H[k] : null);
  const byWeek = new Map<number, number[]>();
  for (const p of all) {
    const id = ids.get(p)!;
    const b = new TicketBuilder({ id, created: p.created, category: p.category, question: p.text!, requester: nextReq(), channel: R() < 0.8 ? HELP_CHANNEL : BUILD_CHANNEL, visibility: p.visibility ?? "thread" });
    buildLifecycle(b, p, R, helperOf, byWeek);
    (byWeek.get(p.week) ?? byWeek.set(p.week, []).get(p.week)!).push(id);
    out.push(b);
  }

  /* ---------- the board (open now) and the imported rows, as drawn in queue.html ---------- */
  out.push(...boardTickets(NOW, req));

  /* ---------- shift to the requested "now" ---------- */
  const tickets: TicketRow[] = [];
  const events = new Map<number, RawEvent[]>();
  const notes = new Map<number, TicketNote[]>();
  const closings = new Map<number, ClosingInfo>();
  const sh = (v: number | null) => (v == null ? v : v + shift);
  for (const b of out) {
    const r = b.row;
    const row: TicketRow = {
      ...r, created_at: r.created_at + shift, claimed_at: sh(r.claimed_at), resolved_at: sh(r.resolved_at),
      first_response_at: sh(r.first_response_at), first_human_response_at: sh(r.first_human_response_at), assigned_at: sh(r.assigned_at),
      reopened_at: sh(r.reopened_at), snoozed_until: sh(r.snoozed_until), updated_at: sh(r.updated_at)
    };
    tickets.push(row);
    events.set(r.id, b.events.map(e => ({ ...e, created_at: e.created_at + shift, detail: e.detail && typeof e.detail.until === "number" ? { ...e.detail, until: e.detail.until + shift } : e.detail })));
    notes.set(r.id, b.notes.map(n => ({ ...n, created_at: n.created_at + shift })));
    if (b.closing && (r.status === "resolved" || r.status === "closed")) closings.set(r.id, b.closing);
  }
  tickets.sort((a, b) => a.id - b.id);

  const persons: Person[] = [
    ...people.map(p => ({ id: p.id, handle: p.handle, name: p.handle })),
    ...[...named.entries()].map(([handle, id]) => ({ id, handle, name: handle }))
  ];
  return { now, tickets, events, notes, closings, participants: persons };
}

function weekOfPlanFinish(p: Plan): number {
  if (!p.finish || p.finish < 0) return -1;
  return Math.floor((p.finish - weekStartOf(1)) / (7 * DAY)) + 1;
}

/** n values with an exact upper median `med`, including the fixed ones (minutes). Falls back to plain samples. */
function lagsWithMedian(R: Rng, fixed: number[], n: number, med: number): number[] {
  const free = n - fixed.length;
  if (free <= 0) return [];
  const k = Math.floor(n / 2);
  const below = fixed.filter(v => v < med).length;
  const hasEq = fixed.includes(med);
  const needBelow = k - below;
  const out: number[] = [];
  if (needBelow < 0 || needBelow + (hasEq ? 0 : 1) > free) {
    for (let i = 0; i < free; i++) out.push(Math.max(2, Math.round(med * Math.exp((R() - 0.5) * 2))));
    return out;
  }
  for (let i = 0; i < needBelow; i++) out.push(Math.max(1, Math.min(med - 1, Math.round(med * (0.15 + 0.84 * R())))));
  if (!hasEq) out.push(med);
  while (out.length < free) out.push(Math.min(1200, med + 1 + Math.round(med * -Math.log(1 - R() * 0.97) * 1.1)));
  return out;
}

/** Events and row fields for one planned ticket. */
function buildLifecycle(b: TicketBuilder, p: Plan, R: Rng, helperOf: (k: HKey | null) => string | null, byWeek: Map<number, number[]>): void {
  const c = p.created, f = p.finish && p.finish > 0 ? p.finish : null;
  const imported = p.visibility === "dashboard";
  if (!imported) b.ack();
  const fr = helperOf(p.fr);
  const lagMs = p.lag != null ? p.lag * MIN : null;
  const needsHuman = !!fr || p.label === "helper" || (p.label === "participant" && R() < 0.4) || (p.label === "person_or_macro" && R() < 0.5);
  if (needsHuman && !imported) {
    const sugg = [H.C, H.S, H.F, H.P, H.D].slice(0, 3);
    b.escalate(c + 50_000, sugg);
    if (fr && lagMs != null) {
      if (R() < 0.35) b.autoAssign(fr, c + 60_000); else b.claim(fr, c + Math.max(60_000, lagMs - 90_000));
      b.reply(fr, c + lagMs);
    } else if (R() < 0.6) {
      b.autoAssign(H[(["P", "C", "D", "F", "S"] as const)[R.int(0, 4)]], c + 60_000);
    }
  }
  if (p.extra) {
    if (p.extra === "duplicate") {
      const same = byWeek.get(p.week) ?? [];
      b.duplicate(H.C, c + 40 * MIN, same.length ? same[same.length - 1] : b.row.id - 1);
    } else if (p.extra === "snoozed") {
      b.snooze(H.S, c + 3 * HOUR, c + 400 * DAY);
    } else {
      b.setStatus("open");
    }
    return;
  }
  if (!f || !p.label) return;
  const credit = helperOf(p.credit) ?? fr;
  // reopen: an earlier finish, then the requester reopens, then the final finish below
  if (p.reopen) {
    const span = f - c;
    const t1 = c + Math.max((lagMs ?? 0) + 5 * MIN, span * 0.35), t2 = c + span * 0.55;
    b.resolve({ at: t1, actor: credit, credit, resolution: credit ? `resolved by <@${credit}>` : "resolved" });
    b.reopen(t2, b.row.requester_id);
    if (credit) b.reply(credit, t2 + Math.min(20 * MIN, span * 0.1));
  }
  switch (p.label) {
    case "helper": {
      const macro = R() < 0.15;
      b.resolve({ at: f, actor: credit, credit, resolution: macro ? "resolved via macro solved" : `resolved by <@${credit}>` });
      break;
    }
    case "participant":
      b.resolve({ at: f, actor: b.row.requester_id, credit: fr, resolution: `resolved by <@${b.row.requester_id}>` });
      break;
    case "orry_last_word": {
      if (credit) b.reply(credit, f);
      const ran = f + 48 * HOUR + R.int(1, 50) * MIN;
      b.resolve({ at: f, actor: null, credit, resolution: "resolved: a helper had the last word and the requester didn't come back", detail: { source: "auto", rule: "last_word", helper: credit }, writtenAt: ran });
      break;
    }
    case "orry_judge": {
      const reason = REASONS[R.int(0, REASONS.length - 1)];
      b.resolve({ at: f, actor: null, credit: fr, resolution: `auto-resolved: ${reason}`, detail: { source: "auto", verdict: "resolved", confidence: 0.86 + R.int(0, 12) / 100, reason }, writtenAt: f + R.int(5, 90) * MIN });
      break;
    }
    case "import_resolved":
      b.resolve({ at: f, actor: null, credit: fr, resolution: "resolved from historical confirmation", detail: { source: "backfill" }, writtenAt: f + R.int(60, 600) * MIN });
      break;
    case "import_closed":
      b.close({ at: f, actor: null, resolution: "no answer (history import)", detail: { source: "backfill", reason: "no answer (history import)" } });
      break;
    case "person_or_macro":
      if (p.macro) b.close({ at: f, actor: PAT, noEvent: true, macro: "duplicate" });
      else b.close({ at: f, actor: PAT });
      break;
  }
  if (R() < 0.08 && fr) b.note(fr, c + (lagMs ?? 0) + 3 * MIN, NOTES[R.int(0, NOTES.length - 1)]);
}

/** The open tickets of queue.html (#1031-#1053, the imported #981-#1002), relative to "now". */
function boardTickets(NOW: number, req: (h: string) => string): TicketBuilder[] {
  const ago = (m: number) => NOW - m * MIN;
  const T = (id: number, m: number, cat: Category, handle: string, q: string, vis: "thread" | "dashboard" = "thread") =>
    new TicketBuilder({ id, created: ago(m), category: cat, question: q, requester: req(handle), channel: HELP_CHANNEL, visibility: vis });
  const out: TicketBuilder[] = [];

  // #1042: released back to the queue by Mia; the oldest wait (at least 5 h 12 min), over the limit, no owner
  const t1042 = T(1042, 318, "review", "tiny-geode", "How do I submit my repo for review? The form says my demo link is invalid but it opens fine for me.").ack();
  t1042.escalate(ago(317), [H.C, H.S, H.F]).claim(H.F, ago(315)).decline(H.F, ago(312), "Not my area, sorry.").release(H.F, ago(312));
  t1042.followup(ago(41), "It still says invalid. I tried twice.").note(H.C, ago(22), "The demo link uses http. The form only accepts https. Probably just needs the https link.");
  out.push(t1042);

  // #1047: reopened by the requester 2 h 40 min ago; the old owner (Leila) is not counted; nobody has replied since
  const t1047 = T(1047, 3 * 1440 + 227, "review", "moss-kiln", "My reviewer said my project passed but the site still shows it as in review. Did it go through?").ack();
  t1047.escalate(ago(3 * 1440 + 226)).claim(H.C, ago(3 * 1440 + 210)).reply(H.C, ago(3 * 1440 + 198));
  t1047.resolve({ at: ago(3 * 1440 - 60), actor: H.C, credit: H.C, resolution: `resolved by <@${H.C}>` }).reopen(ago(160), req("moss-kiln"));
  out.push(t1047);

  // #1045: claimed by Leila, replied after 12 min
  const t1045 = T(1045, 200, "review", "night-tern", "My reviewer asked for a build log. Where do I upload it so they can see it?").ack();
  t1045.escalate(ago(199)).claim(H.C, ago(192)).reply(H.C, ago(188));
  out.push(t1045);

  // #1031: reopened twice, then Ravi assigned it to himself after the second reopen (in progress, owner counts)
  const t1031 = T(1031, 2 * 1440 + 22, "site_bug", "copper-moth", "My hours tracker went back to zero after I reopened my project page.").ack();
  t1031.escalate(ago(2 * 1440 + 21)).claim(H.S, ago(2 * 1440 + 10)).reply(H.S, ago(2 * 1440 + 6));
  t1031.resolve({ at: ago(1440 + 1200), actor: H.S, credit: H.S, resolution: `resolved by <@${H.S}>` }).reopen(ago(1440 + 300), req("copper-moth"));
  t1031.reply(H.D, ago(1440 + 260)).resolve({ at: ago(1440 + 180), actor: H.D, credit: H.D, resolution: `resolved by <@${H.D}>` });
  t1031.reopen(ago(185), req("copper-moth")).assign(H.D, H.D, ago(170));
  t1031.note(H.D, ago(1440 + 255), "Asked for a screen recording. Waiting on the requester.").note(H.D, ago(150), "Tracker resets when the page is reopened twice. Logged it for the site team.").note(H.S, ago(140), "Same thing happened on #1012 last week.");
  out.push(t1031);

  // #1049: auto-assigned to Mia, then she escalated it to organizers; no reply yet; near the limit
  const t1049 = T(1049, 98, "fulfillment_shipping", "bright-shale", "When do Physical Loadout parts ship if my build was approved last Friday?").ack();
  t1049.escalate(ago(97)).autoAssign(H.F, ago(97)).escalateByHelper(H.F, ago(78));
  out.push(t1049);

  // #1051: assigned to Juno automatically (no ping); mine
  const t1051 = T(1051, 34, "advice_how_to", "iron-sprout", "How do I set up the wiring diagram tool on a school Chromebook?").ack();
  t1051.escalate(ago(33)).autoAssign(H.P, ago(33));
  out.push(t1051);

  // #1053: sensitive (the site's detector matches), new, no owner
  const t1053 = T(1053, 6, "other", "lumen-vole", "I'd rather talk to a person about something, not the bot.").ack();
  t1053.escalate(ago(5));
  out.push(t1053);

  // status open, never escalated (answered by Orry, or never confirmed)
  out.push(T(1050, 52, "other", "grit-heron", "Is the Hardware track allowed to use a prebuilt dev board, or does it have to be from scratch?").ack());
  out.push(T(1048, 95, "other", "pebble-lynx", "How much Ore is a 10 hour approved build worth? Orry said Bolts.").ack());
  out.push(T(1044, 240, "account_access", "opal-mite", "Can I change the email on my account after signing up?").ack());
  out.push(T(1039, 3240, "site_bug", "rust-pika", "The project gallery page is not loading on my phone.").ack());

  // parked
  const t1036 = T(1036, 1500, "review", "cinder-ibis", "Can I resubmit after the deadline if my reviewer was away?").ack();
  t1036.escalate(ago(1499)).claim(H.S, ago(1475)).reply(H.S, ago(1470)).snooze(H.S, ago(1440), NOW + 400 * DAY);
  out.push(t1036);
  const t1040 = T(1040, 290, "review", "tiny-geode", "Demo link rejected on the review form.").ack();
  t1040.duplicate(H.C, ago(280), 1042);
  out.push(t1040);

  // imported by Orry's history import (visibility dashboard, backdated created_at)
  const imp: Array<[number, number, Category, string, string]> = [
    [981, 18720, "other", "fern-quokka", "anyone else's build stuck on step 3?"],
    [986, 17300, "other", "pebble-wisp", "thanks that worked"],
    [990, 16100, "review", "drift-yak", "is review open on weekends"],
    [994, 15020, "other", "brass-gnat", "same question as above"],
    [997, 14400, "fulfillment_shipping", "loam-crane", "did the stickers ship yet"],
    [1002, 13050, "other", "mica-shrew", "ok will try that tonight"]
  ];
  for (const [id, m, cat, h, q] of imp) { const t = T(id, m, cat, h, q, "dashboard"); t.row.updated_at = ago(m - 20); out.push(t); }
  return out;
}

/** The changes a poll picks up 30 s after start (queue.html PENDING): #1054 arrives, #1047 and #1053 get owners. */
export function applyPendingChanges(d: FixtureData): FixtureData {
  const tickets = d.tickets.map(t => ({ ...t }));
  const events = new Map(d.events);
  const at = d.now - 30_000;
  const t1054: TicketRow = {
    ...tickets.find(t => t.id === 1051)!, id: 1054, question: "Where is the parts list for the Compute track?", category: "advice_how_to",
    requester_id: "U0RB09001", status: "waiting_for_helper", assignee_id: null, assigned_at: null, created_at: d.now - 60_000, updated_at: d.now - 50_000,
    first_response_at: d.now - 55_000, thread_ts: `${Math.floor((d.now - 60_000) / 1000)}.000054`, notes_count: 0, first_human_response_at: null, first_responder_id: null
  };
  tickets.push(t1054);
  events.set(1054, [
    { id: 900001, ticket_id: 1054, actor_id: "U0RB09001", event_type: "created", detail: null, created_at: d.now - 60_000 },
    { id: 900002, ticket_id: 1054, actor_id: null, event_type: "escalated", detail: { by: "ai_no_answer" }, created_at: d.now - 50_000 }
  ]);
  const t1047 = tickets.find(t => t.id === 1047)!;
  Object.assign(t1047, { status: "assigned", assignee_id: H.S, assigned_at: at, updated_at: at });
  events.set(1047, [...(d.events.get(1047) ?? []), { id: 900003, ticket_id: 1047, actor_id: H.S, event_type: "assigned", detail: { to: H.S }, created_at: at }]);
  const t1053 = tickets.find(t => t.id === 1053)!;
  Object.assign(t1053, { status: "claimed", assignee_id: H.C, claimed_at: at, assigned_at: at, updated_at: at });
  events.set(1053, [...(d.events.get(1053) ?? []), { id: 900004, ticket_id: 1053, actor_id: H.C, event_type: "claimed", detail: null, created_at: at }]);
  const participants = [...d.participants, { id: "U0RB09001", handle: "sable-finch", name: "sable-finch" }];
  return { ...d, tickets, events, participants };
}
