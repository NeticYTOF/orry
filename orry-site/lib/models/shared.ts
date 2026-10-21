/* Shared pieces of the view-models: panel states and freshness (PLAN 4.0), comparison words, labels. JSON only. */
import type { DataSource } from "../data/types";
import { isDataError, type DataError } from "../data/types";
import type { Read } from "../data/cache";
import { formatDuration, hhmm, MIN } from "../metrics/time";
import type { Role } from "../session";

/** Exactly one per panel, chosen on the server (PLAN 4.0 shared panel states). */
export type PanelState = "live" | "stale" | "offline" | "not_connected" | "needs_update" | "error";

export type Freshness = {
  state: PanelState;
  /** ISO time of the data shown (the last good read); null when there is none */
  at: string | null;
  ageMs: number | null;
  /** "LIVE · 14:02", "STALE · 9 MIN OLD", "OFFLINE · LAST SEEN 13:20", "NOT CONNECTED", "ERROR" */
  tag: string;
  /** Banner text for stale and offline, else null. */
  banner: string | null;
  /** Ticket text is hidden after 10 minutes stale (PLAN 4.0). */
  hideText: boolean;
  /** Rows hide behind "Show last known data" after 1 hour offline. */
  hideRows: boolean;
  showLastKnownLabel: string | null;
};

export type PanelError = {
  kind: DataError["kind"];
  /** What every role sees, one plain sentence. */
  message: string;
  /** The next step, organizers only (null for helpers). */
  detail: string | null;
  gap: string | null;
  retry: boolean;
};

/** The time the data describes, as "14:02" (UTC). Fixtures report their fixed instant, minus the cache age. */
export function dataClock(ds: DataSource, fetchedAt: number): number {
  return ds.mode === "fixtures" ? ds.now() - Math.floor((Date.now() - fetchedAt) / MIN) * MIN : fetchedAt;
}

export function freshnessOf(ds: DataSource, r: Pick<Read<unknown>, "fetchedAt" | "stale"> | null, err: DataError | null = null): Freshness {
  if (!r) {
    const kind = err?.kind;
    const state: PanelState = kind === "not_connected" || kind === "unauthorized" ? "not_connected" : kind === "needs_update" ? "needs_update" : kind === "offline" || kind === "timeout" ? "offline" : "error";
    return { state, at: null, ageMs: null, tag: state === "not_connected" ? "NOT CONNECTED" : state === "offline" ? "OFFLINE" : state === "needs_update" ? "NEEDS AN ORRY UPDATE" : "ERROR", banner: state === "offline" ? "Orry is offline. There is no earlier data to show." : null, hideText: true, hideRows: true, showLastKnownLabel: null };
  }
  const at = dataClock(ds, r.fetchedAt);
  const age = Date.now() - r.fetchedAt;
  if (!r.stale) return { state: "live", at: new Date(at).toISOString(), ageMs: age, tag: `LIVE · ${hhmm(at)}`, banner: null, hideText: false, hideRows: false, showLastKnownLabel: null };
  const mins = Math.max(1, Math.floor(age / MIN));
  if (age < 5 * MIN) {
    return { state: "stale", at: new Date(at).toISOString(), ageMs: age, tag: `STALE · ${mins} MIN OLD`, banner: `Can't reach Orry since ${hhmm(at)}. Showing the last data, ${mins} minute${mins === 1 ? "" : "s"} old.`, hideText: false, hideRows: false, showLastKnownLabel: null };
  }
  const hideRows = age >= 60 * MIN;
  return {
    state: age < 10 * MIN ? "stale" : "offline", at: new Date(at).toISOString(), ageMs: age,
    tag: age < 10 * MIN ? `STALE · ${mins} MIN OLD` : `OFFLINE · LAST SEEN ${hhmm(at)}`,
    banner: age < 10 * MIN ? `Can't reach Orry since ${hhmm(at)}. Showing the last data, ${mins} minutes old.` : `Orry is offline. Showing data from ${hhmm(at)} UTC.`,
    hideText: age >= 10 * MIN, hideRows, showLastKnownLabel: hideRows ? `Show last known data (${formatDuration(age, { nbsp: false })} old)` : null
  };
}

export function panelError(e: unknown, role: Role): PanelError {
  const org = role === "organizer";
  if (!isDataError(e)) return { kind: "error", message: "Something went wrong reading Orry's data.", detail: null, gap: null, retry: true };
  switch (e.kind) {
    case "not_connected":
      return { kind: e.kind, message: "Orry's data is not connected yet.", detail: org ? (/RIVET_CORE_BASE_URL/.test(e.message) ? "The site has no bridge address. Set RIVET_CORE_BASE_URL, then run the config check." : "Orry's data bridge is switched off. Its owner needs to set RIVET_INTERNAL_TOKEN.") : null, gap: null, retry: false };
    case "unauthorized":
      return { kind: e.kind, message: "Orry's data is not connected yet.", detail: org ? "The site's bridge token doesn't match Orry's." : null, gap: null, retry: false };
    case "needs_update":
      return { kind: e.kind, message: e.message, detail: null, gap: e.gap ?? null, retry: false };
    case "shape":
      return { kind: e.kind, message: "This Orry version isn't supported yet: its answer had an unexpected shape.", detail: org ? `Route: ${e.route ?? "unknown"}.` : null, gap: null, retry: true };
    case "offline": case "timeout":
      return { kind: e.kind, message: "Orry did not answer.", detail: null, gap: null, retry: true };
    case "rate_limited":
      return { kind: e.kind, message: "The site is waiting before it asks Orry again.", detail: null, gap: null, retry: true };
    default:
      return { kind: e.kind, message: "Orry answered with an error.", detail: null, gap: null, retry: true };
  }
}

/* ---------- comparison words (no arrows, no colours) ---------- */

export function compareCount(cur: number, prev: number | null | undefined): string | null {
  if (prev == null) return null;
  return cur > prev ? `Up from ${prev}` : cur < prev ? `Down from ${prev}` : "Same as last week";
}
export function comparePct(cur: number | null, prev: number | null | undefined): string | null {
  if (cur == null || prev == null) return null;
  return cur > prev ? `Up from ${prev} %` : cur < prev ? `Down from ${prev} %` : "Same as last week";
}
/** Durations: lower is better, so the words are "faster" and "slower". */
export function compareDuration(cur: number | null, prev: number | null | undefined): string | null {
  if (cur == null || prev == null) return null;
  const a = Math.floor(cur / MIN), b = Math.floor(prev / MIN);
  return a < b ? `Faster than ${formatDuration(prev)}` : a > b ? `Slower than ${formatDuration(prev)}` : "Same as last week";
}

/** Durations or the small-n reason, never 0 and never a dash (PLAN 4.0). */
export const durOrFew = (v: number | null, n: number, tooFew: boolean): string => (tooFew || v == null ? `Too few tickets (n = ${n})` : formatDuration(v));
export const durOrFewShort = (v: number | null, n: number, tooFew: boolean): string => (tooFew || v == null ? `Too few (n = ${n})` : formatDuration(v));

export const CATEGORY_LABEL: Record<string, string> = {
  review: "Review", fulfillment_shipping: "Shipping", account_access: "Account access", site_bug: "Site bug", advice_how_to: "How to", other: "Other"
};
export const categoryLabel = (c: string | null | undefined): string => (c ? CATEGORY_LABEL[c] ?? c.replace(/_/g, " ") : "Other");

export const pctText = (n: number | null): string => (n == null ? "No data" : `${n} %`);
