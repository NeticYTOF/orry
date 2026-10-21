/* The board's browser state: view, filters, sort and grouping, and how they map to the URL (?view=, ?q=, ...).
   Pure functions only, so they run on the server for the first paint and in vitest. Filtering itself is DATA's
   rowsFor() / facetCounts() from lib/models/boardTypes.ts; this file adds sorting, grouping and the URL. */
import { facetCounts, rowsFor, type AgeBucket, type BoardFilters, type BoardModel, type BoardRow, type BoardView } from "@/lib/models/boardTypes";

export const VIEW_KEYS: BoardView[] = ["human", "noowner", "mine", "orry", "48h", "imp", "parked", "all"];
export const FIRST_TABS: BoardView[] = ["human", "mine", "noowner"];

export type SortKey = "wait" | "id" | "st" | "cat" | "owner" | "reply" | "act";
export type GroupKey = "" | "owner" | "cat" | "st";
export type FacetKey = "status" | "category" | "owner" | "age";

export type BoardUi = {
  view: BoardView;
  text: string;
  f: Record<FacetKey, string[]>;
  over: boolean;
  imp: boolean;
  sort: SortKey;
  dir: "asc" | "desc";
  group: GroupKey;
};

export const SORTS: Array<{ value: `${SortKey}:${"asc" | "desc"}`; label: string }> = [
  { value: "wait:desc", label: "Waiting, oldest first" },
  { value: "wait:asc", label: "Waiting, newest first" },
  { value: "id:asc", label: "Number" },
  { value: "st:asc", label: "Status" },
  { value: "cat:asc", label: "Category" },
  { value: "owner:asc", label: "Owner" },
  { value: "reply:asc", label: "Human reply" },
  { value: "act:desc", label: "Last activity, oldest first" }
];
export const GROUPS: Array<{ value: GroupKey; label: string }> = [
  { value: "", label: "No grouping" }, { value: "owner", label: "By owner" }, { value: "cat", label: "By category" }, { value: "st", label: "By status" }
];
export const AGES: Array<{ key: AgeBucket; label: string }> = [
  { key: "lt1", label: "Under 1 h" }, { key: "1to6", label: "1 to 6 h" }, { key: "6to24", label: "6 to 24 h" }, { key: "1to2d", label: "1 to 2 days" }, { key: "gt2d", label: "Over 2 days" }
];
const SORT_KEYS: SortKey[] = ["wait", "id", "st", "cat", "owner", "reply", "act"];
const PARAM: Record<FacetKey, string> = { status: "status", category: "cat", owner: "owner", age: "age" };

export const emptyUi = (view: BoardView = "human"): BoardUi => ({
  view, text: "", f: { status: [], category: [], owner: [], age: [] }, over: false, imp: false, sort: "wait", dir: "desc", group: ""
});

type Params = { get(name: string): string | null };
const list = (v: string | null) => (v ? v.split(",").map(s => s.trim()).filter(Boolean).slice(0, 40) : []);

/** Reads the board state from the URL. Unknown values fall back to the defaults. */
export function parseUi(p: Params): BoardUi {
  const view = VIEW_KEYS.includes(p.get("view") as BoardView) ? (p.get("view") as BoardView) : "human";
  const u = emptyUi(view);
  u.text = (p.get("q") ?? "").slice(0, 100);
  for (const k of Object.keys(PARAM) as FacetKey[]) u.f[k] = list(p.get(PARAM[k]));
  u.f.age = u.f.age.filter(a => AGES.some(x => x.key === a));
  u.over = p.get("over") === "1";
  u.imp = p.get("imp") === "1";
  const [sk, sd] = (p.get("sort") ?? "").split(":");
  if (SORT_KEYS.includes(sk as SortKey)) { u.sort = sk as SortKey; u.dir = sd === "asc" ? "asc" : "desc"; }
  const g = p.get("group") ?? "";
  if (GROUPS.some(x => x.value === g)) u.group = g as GroupKey;
  return u;
}

/** The query string for a state ("" for the defaults). Defaults are left out so links stay short. */
export function uiQuery(u: BoardUi): string {
  const q = new URLSearchParams();
  if (u.view !== "human") q.set("view", u.view);
  if (u.text) q.set("q", u.text);
  for (const k of Object.keys(PARAM) as FacetKey[]) if (u.f[k].length) q.set(PARAM[k], u.f[k].join(","));
  if (u.over) q.set("over", "1");
  if (u.imp) q.set("imp", "1");
  if (u.sort !== "wait" || u.dir !== "desc") q.set("sort", `${u.sort}:${u.dir}`);
  if (u.group) q.set("group", u.group);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const filtersOn = (u: BoardUi): boolean => !!(u.text || u.over || Object.values(u.f).some(a => a.length));

export function toFilters(u: BoardUi): BoardFilters {
  return {
    status: u.f.status, category: u.f.category, owner: u.f.owner, age: u.f.age as AgeBucket[],
    overOnly: u.over, showImported: u.imp, text: u.text || undefined
  };
}

const sortVal = (r: BoardRow, k: SortKey): number | string => {
  switch (k) {
    case "wait": return r.sort.wait;
    case "id": return r.sort.id;
    case "st": return r.sort.status;
    case "cat": return r.sort.category;
    case "owner": return r.sort.owner;
    case "reply": return r.sort.reply;
    case "act": return -r.sort.lastChange;   // "oldest first" on desc, as in the mockup
  }
};

export function sortRows(rows: BoardRow[], sort: SortKey, dir: "asc" | "desc"): BoardRow[] {
  const d = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = sortVal(a, sort), y = sortVal(b, sort);
    const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : x > y ? 1 : x < y ? -1 : 0;
    return c * d || b.waitMs - a.waitMs || a.id - b.id;
  });
}

/** The rows the table shows: view, filters, then sort. Grouping keeps the sort inside each group. */
export function visibleRows(m: Pick<BoardModel, "rows">, u: BoardUi): BoardRow[] {
  const rows = sortRows(rowsFor(m, u.view, toFilters(u)), u.sort, u.dir);
  if (!u.group) return rows;
  const order: string[] = [];
  const by = new Map<string, BoardRow[]>();
  for (const r of rows) { const k = groupKey(r, u.group); if (!by.has(k)) { by.set(k, []); order.push(k); } by.get(k)!.push(r); }
  return order.flatMap(k => by.get(k)!);
}

export function ownerText(r: BoardRow): string {
  if (r.ownerState === "you") return "You";
  if (r.owner) return r.owner.label;
  if (r.previousOwner) return `Previously ${r.previousOwner.label}`;
  if (r.releasedBy) return `Released by ${r.releasedBy.label}`;
  return "No owner";
}

export function groupKey(r: BoardRow, g: GroupKey): string {
  return g === "owner" ? ownerText(r) : g === "cat" ? r.categoryLabel : g === "st" ? baseStatus(r.statusWord) : "";
}

export const baseStatus = (w: string): string => w.replace(/\s×\d+$/, "");

/** All rows of the view before the facets (the "of N" in "Showing 7 of 7"). */
export const viewTotal = (m: Pick<BoardModel, "rows">, u: BoardUi): number => rowsFor(m, u.view, { showImported: u.imp }).length;

/** Facet options with counts over the whole view, every other filter applied (the mockup's facet popovers). */
export function facetOptions(m: Pick<BoardModel, "rows" | "me" | "categories">, u: BoardUi): Record<FacetKey, Array<{ value: string; label: string; n: number }>> {
  const f = toFilters(u);
  const base = rowsFor(m, u.view, { showImported: u.imp });
  const counts = (k: FacetKey) => facetCounts(m, u.view, k, f);
  const status = [...new Map(base.map(r => [r.facets.status, baseStatus(r.statusWord)])).entries()];
  const others = [...new Map(base.filter(r => r.owner && r.owner.id !== m.me.id).map(r => [r.owner!.id, r.owner!.label])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const with_ = (k: FacetKey, opts: Array<[string, string]>) => { const c = counts(k); return opts.map(([value, label]) => ({ value, label, n: c.get(value) ?? 0 })); };
  return {
    status: with_("status", status),
    category: with_("category", m.categories.filter(c => base.some(r => r.category === c.key)).map(c => [c.key, c.label])),
    owner: with_("owner", [["_none", "No owner"], [m.me.id, "Me"], ...others]),
    age: with_("age", AGES.map(a => [a.key, a.label]))
  };
}

/** How many View-menu options differ from the defaults (the "(2)" on the View button). */
export function viewMenuCount(u: BoardUi, roomy: boolean): number {
  return (u.sort !== "wait" || u.dir !== "desc" ? 1 : 0) + (u.group ? 1 : 0) + (u.over ? 1 : 0) + (u.imp ? 1 : 0) + (roomy ? 1 : 0);
}

/** Rows that left the view after Apply, with the reason shown for one cycle ("claimed by Leila Haddad"). */
export function leavers(before: BoardRow[], after: BoardModel, u: BoardUi): Array<{ id: number; why: string }> {
  const now = new Set(visibleRows(after, u).map(r => r.id));
  return before.filter(r => !now.has(r.id)).map(r => {
    const a = after.rows.find(x => x.id === r.id);
    const why = !a ? "finished or closed" : a.owner && a.owner.id !== r.owner?.id ? `claimed by ${a.owner.label}` : a.status !== r.status ? `now ${baseStatus(a.statusWord).toLowerCase()}` : "changed";
    return { id: r.id, why };
  });
}
