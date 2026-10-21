/* Small formatters for the auth and admin screens. Times are shown in UTC with the zone named. */

export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

const DAY = 86_400_000;
const utcDay = (ms: number) => Math.floor(ms / DAY);

/** "Today 14:02", "Yesterday", "3 days ago", "12 Oct" (UTC). */
export function fmtWhen(ms: number | null, nowMs: number): string {
  if (!ms) return "Never";
  const d = utcDay(nowMs) - utcDay(ms);
  const time = new Date(ms).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  if (d <= 0) return `Today ${time}`;
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "In 6 days", "In 5 h", "3 days ago". */
export function fmtRelative(ms: number, nowMs: number): string {
  const diff = ms - nowMs, abs = Math.abs(diff);
  const v = abs >= DAY ? `${Math.round(abs / DAY)} day${Math.round(abs / DAY) === 1 ? "" : "s"}` : abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.max(1, Math.round(abs / 60_000))} min`;
  return diff >= 0 ? `In ${v}` : `${v} ago`;
}

export const fmtDay = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
