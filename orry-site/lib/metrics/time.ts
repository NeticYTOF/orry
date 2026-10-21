/* ISO weeks and days in UTC (PLAN 4.0 "Times", 4.3), and the duration format of PLAN 4.0 "Numbers". Pure. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type WeekKey = `${number}-W${string}`;
export type WeekRange = { key: string; year: number; week: number; start: number; end: number };

/** Monday 00:00 UTC of the ISO week that contains `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

/** ISO year and week number of `ms`. */
export function isoWeek(ms: number): { year: number; week: number } {
  const start = weekStart(ms);
  const thursday = new Date(start + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = weekStart(jan4);
  return { year, week: Math.round((start - week1) / WEEK) + 1 };
}

export function weekKey(ms: number): string {
  const { year, week } = isoWeek(ms);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** "2026-W42" → its UTC range; end is exclusive (the next Monday 00:00:00.000). null when the key is malformed. */
export function parseWeek(key: string): WeekRange | null {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const start = weekStart(Date.UTC(year, 0, 4)) + (week - 1) * WEEK;
  if (isoWeek(start).year !== year) return null; // week 53 in a 52-week year
  return { key: `${year}-W${String(week).padStart(2, "0")}`, year, week, start, end: start + WEEK };
}

export function weekOf(ms: number): WeekRange {
  return parseWeek(weekKey(ms))!;
}

export function shiftWeek(key: string, by: number): string {
  const r = parseWeek(key);
  if (!r) return key;
  return weekKey(r.start + by * WEEK + DAY);
}

/** The last `n` week keys ending with `key` (oldest first). */
export function lastWeeks(key: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftWeek(key, -i));
  return out;
}

/** "W42" */
export const shortWeek = (key: string): string => key.replace(/^\d{4}-/, "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "12 to 18 Oct" (UTC), or "28 Sep to 4 Oct" across months. */
export function weekSpanLabel(r: WeekRange): string {
  const a = new Date(r.start), b = new Date(r.end - DAY);
  const am = MONTHS[a.getUTCMonth()], bm = MONTHS[b.getUTCMonth()];
  return am === bm ? `${a.getUTCDate()} to ${b.getUTCDate()} ${bm}` : `${a.getUTCDate()} ${am} to ${b.getUTCDate()} ${bm}`;
}

/** "25 Oct" */
export const dayMonth = (ms: number): string => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
/** "Sun 18 Oct 16:40" (UTC) */
export function dayTime(ms: number): string {
  const d = new Date(ms);
  return `${DAYS3[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hhmm(ms)}`;
}
/** "14:02" (UTC) */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** Monday = 0 … Sunday = 6, UTC */
export const utcWeekday = (ms: number): number => (new Date(ms).getUTCDay() + 6) % 7;

/**
 * Durations use the largest two units: "41 min", "3 h 12 min", "2 d 4 h" (PLAN 4.0). Minutes are floored.
 * `nbsp` joins a number and its unit with U+00A0, as the mockups do.
 */
export function formatDuration(ms: number, o: { nbsp?: boolean } = {}): string {
  const sp = o.nbsp === false ? " " : " ";
  const u = (n: number, w: string) => `${n}${sp}${w}`;
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return u(m, "min");
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? `${u(h, "h")} ${u(r, "min")}` : u(h, "h"); }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? `${u(d, "d")} ${u(h, "h")}` : u(d, "d");
}

/** ISO 8601 duration for `<time datetime>`: "PT5H12M", "P2DT3H0M". */
export function isoDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MIN));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  return `P${d ? d + "D" : ""}T${h}H${r}M`;
}
