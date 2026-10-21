/* Small helpers for the server-rendered charts. Server-safe (no hooks). */

/** The chart widths drawn on the server; CSS shows the one that fits the main column (see "UI additions"). */
export const VARIANTS = [
  { w: 320, cls: "vz vz-s" },
  { w: 400, cls: "vz vz-m" },
  { w: 620, cls: "vz vz-l" }
] as const;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** For text inside a data-tip (the tip is set with innerHTML). */
export const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, c => ESC[c]!);

export const pct = (v: number, t: number): number => (t ? Math.round((v / t) * 100) : 0);
export const SIGN = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

/** A round top for an axis: 70 for 61, 10 for 4. */
export function niceMax(v: number, step = 10): number {
  return Math.max(step, Math.ceil((v * 1.1) / step) * step);
}

/** "W42" from "2026-W42"-style short labels, kept as given. Week number from "W42". */
export const weekNum = (short: string): string => short.replace(/^W/, "");
