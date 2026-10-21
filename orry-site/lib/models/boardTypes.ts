/* Board view-model types and the pure filter helpers the board's client code can use (no server imports here). */
import type { PersonRef } from "../people";
import type { Freshness, PanelError } from "./shared";

export type BoardView = "human" | "mine" | "noowner" | "orry" | "48h" | "imp" | "parked" | "all";
export type AgeBucket = "lt1" | "1to6" | "6to24" | "1to2d" | "gt2d";
export type LimitChipKind = "over" | "near" | "unknown";

export type BoardQuery = { view?: string | null };

export type BoardRow = {
  id: number;
  href: string;                         // "/tickets/1042"
  slackUrl: string | null;              // null for tickets outside the program's channels
  status: string;                       // Orry's status, or "released" for status open with assigned_at kept
  statusWord: string;                   // "Waiting", "Released", "Reopened ×2", "Answered or unconfirmed" …
  statusSprite: "ticket" | "people" | "list" | "layers";
  statusClass: "" | "quiet" | "dot";
  waitMs: number;
  waitText: string;                     // "5 h 12 min" (U+00A0 between number and unit)
  waitIso: string;                      // "PT5H12M"
  atLeast: boolean;                     // released tickets, and every wait while stale: print "≥"
  limit: LimitChipKind | null;
  limitText: string | null;             // "Over 2 h", "Near 1 h 30 min", "Unknown: 100+ events" / "Unknown: not checked yet"
  limitNote: string | null;             // visible explanation for the sheet / details
  /** First 140 characters, or null when withheld; see questionNote */
  question: string | null;
  questionNote: string | null;          // "Sensitive topic. Open the ticket to read it." etc.
  sensitive: boolean;
  category: string;
  categoryLabel: string;
  humanReply: "none" | "after" | "none_since_reopen" | "since_reopen" | "unknown";
  humanReplyText: string;               // "None yet", "after 12 min", "None recorded since reopen"
  lastChangeText: string;               // "3 min ago" (from updated_at)
  flags: Array<{ key: string; text: string }>;
  owner: PersonRef | null;              // current owner (null = no owner)
  ownerState: "none" | "you" | "person";
  previousOwner: PersonRef | null;      // "Previously <name>" (reopened)
  releasedBy: PersonRef | null;         // "Released by <name>"
  views: BoardView[];
  facets: { status: string; category: string; owner: string; age: AgeBucket };
  isNew: boolean;
  imported: boolean;
  /** Sort keys so the client never recomputes metrics. */
  sort: { wait: number; id: number; status: string; owner: string; category: string; reply: number; lastChange: number };
};

export type BoardModel = {
  generatedAt: string;
  version: string;                      // changes when any row's id, status, owner or wait state changes
  freshness: Freshness;
  error: PanelError | null;
  role: "helper" | "organizer";
  me: PersonRef;
  view: BoardView;
  limitMinutes: number;
  headline: {
    needHuman: number;
    word: string;                       // "need a human now" / "needs a human now"
    waitingFirstReply: number;
    inProgress: number;
    noOwner: number;
    oldest: { id: number; href: string; waitText: string; waitIso: string; atLeast: boolean } | null;
    over: number;
    near: number;
    unknown: number;
    limitLabel: string;                 // "site limit 2 h"
    limitSource: "site" | "bot";
    typicalReply: { text: string; note: string; n: number } | null;   // K12, hidden when Orry says not available
    filterNote: string;                 // "These numbers describe everything that needs a human, not the view or filters below."
  };
  views: Array<{ key: BoardView; label: string; tabLabel: string; count: number; head: string | null; shortcut: number }>;
  rows: BoardRow[];                     // every row of every view; filter with rowsFor()
  load: Array<{ key: string; person: PersonRef | null; label: string; n: number; oldestText: string | null; over: number; you: boolean; line: string }>;
  queueShape: Record<BoardView, Array<{ label: string; n: number }>>;
  categories: Array<{ key: string; label: string }>;
  banners: Array<{ key: string; text: string }>;
  empty: null | { kind: "nothing_needs_human" | "no_open"; title: string; body: string; links: Array<{ view: BoardView; label: string; count: number }> };
  definitions: Array<{ term: string; definition: string }>;
};

export type BoardFilters = {
  status?: string[]; category?: string[]; owner?: string[]; age?: AgeBucket[];
  overOnly?: boolean; showImported?: boolean; text?: string;
};

/** Rows of one view, with the toggles and facets applied (counts in the facets cover the whole view). */
export function rowsFor(m: Pick<BoardModel, "rows">, view: BoardView, f: BoardFilters = {}, skip?: keyof BoardFilters): BoardRow[] {
  return m.rows.filter(r => {
    if (!r.views.includes(view)) return false;
    if (view === "all" && !f.showImported && r.imported) return false;
    if (f.text) { const s = f.text.toLowerCase().replace(/^#/, ""); if (!`${r.sensitive ? "" : (r.question ?? "").toLowerCase()} ${r.id}`.includes(s)) return false; }
    if (skip !== "status" && f.status?.length && !f.status.includes(r.facets.status)) return false;
    if (skip !== "category" && f.category?.length && !f.category.includes(r.facets.category)) return false;
    if (skip !== "owner" && f.owner?.length && !f.owner.includes(r.facets.owner)) return false;
    if (skip !== "age" && f.age?.length && !f.age.includes(r.facets.age)) return false;
    if (f.overOnly && r.limit !== "over") return false;
    return true;
  });
}

/** Facet value counts for one facet, with every other filter applied. */
export function facetCounts(m: Pick<BoardModel, "rows">, view: BoardView, facet: "status" | "category" | "owner" | "age", f: BoardFilters = {}): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rowsFor(m, view, f, facet)) out.set(r.facets[facet], (out.get(r.facets[facet]) ?? 0) + 1);
  return out;
}
