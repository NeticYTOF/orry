/* Status and limit chips (PLAN 8.5): the word carries the meaning, the sprite and the border style back it up. */

const SPRITE: Record<string, string> = { assigned: "people", claimed: "people", snoozed: "list", duplicate: "layers" };
const CLS: Record<string, string> = { assigned: "quiet", claimed: "quiet", open: "dot", snoozed: "dot", duplicate: "dot" };

export function StatusChip({ status, word, sprite, cls }: { status: string; word: string; sprite?: string; cls?: string }) {
  const s = sprite ?? SPRITE[status] ?? "ticket";
  const c = cls ?? (status === "released" ? "" : CLS[status] ?? "");
  return <span className={"chip" + (c ? " " + c : "")}><span className={`spr s-${s}`} aria-hidden="true" />{word}</span>;
}

export function LimitChip({ limit, text, note }: { limit: "over" | "near" | "unknown" | null; text: string | null; note?: string | null }) {
  if (!limit || !text) return null;
  /* "Near 1 h 30 min" is printed "Near 1 h 30", as in the mockup, so the chip fits the Waiting column */
  const shown = limit === "near" ? text.replace(/(\d)[\s ]+min$/, "$1") : text;
  return <span className={`chip ${limit}`} title={note ?? undefined}>{shown}</span>;
}
