/* The board's browser-side filtering, sorting, grouping and URL state (components/board/boardState.ts) over the
   fixture board: the same rows the page shows. */
import { beforeAll, describe, expect, it } from "vitest";
import { emptyUi, facetOptions, filtersOn, groupKey, leavers, parseUi, uiQuery, viewTotal, visibleRows, type BoardUi } from "../components/board/boardState";
import { getBoardModel, setLogEvent, type BoardModel } from "../lib/models";

const juno = { accountId: 2, slackId: "U0JUNO001", role: "helper" as const, handle: "pixel-otter", name: "Juno Baker" };
let m: BoardModel;
const ui = (p: Partial<BoardUi> = {}): BoardUi => ({ ...emptyUi(), ...p, f: { ...emptyUi().f, ...(p.f ?? {}) } });

beforeAll(async () => {
  setLogEvent(() => undefined);
  m = await getBoardModel(juno, {});
});

describe("board filtering in the browser", () => {
  it("shows the headline's tickets in Needs a human, oldest first", () => {
    const rows = visibleRows(m, ui());
    expect(rows.length).toBe(m.headline.needHuman);
    expect(rows.map(r => r.waitMs)).toEqual([...rows.map(r => r.waitMs)].sort((a, b) => b - a));
    expect(viewTotal(m, ui())).toBe(rows.length);
  });

  it("filters by over the limit, owner and text, and the facet counts cover the whole view", () => {
    expect(visibleRows(m, ui({ over: true })).length).toBe(m.headline.over);
    const none = visibleRows(m, ui({ f: { status: [], category: [], owner: ["_none"], age: [] } }));
    expect(none.length).toBe(m.headline.noOwner);
    expect(none.every(r => !r.owner)).toBe(true);
    const oldest = m.headline.oldest!.id;
    expect(visibleRows(m, ui({ text: `#${oldest}` })).map(r => r.id)).toEqual([oldest]);
    const ownerFacet = facetOptions(m, ui({ over: true })).owner.find(o => o.value === "_none")!;
    expect(ownerFacet.n).toBe(visibleRows(m, ui({ over: true, f: { status: [], category: [], owner: ["_none"], age: [] } })).length);
  });

  it("never matches a sensitive ticket by its hidden text", () => {
    const sens = m.rows.find(r => r.sensitive && r.views.includes("human"));
    expect(sens).toBeTruthy();
    expect(sens!.question).toBeNull();
    expect(visibleRows(m, ui({ text: "person" })).some(r => r.id === sens!.id)).toBe(false);
    expect(visibleRows(m, ui({ text: String(sens!.id) })).map(r => r.id)).toContain(sens!.id);
  });

  it("sorts by number and keeps groups together", () => {
    const byId = visibleRows(m, ui({ view: "all", sort: "id", dir: "asc" })).map(r => r.id);
    expect(byId).toEqual([...byId].sort((a, b) => a - b));
    const grouped = visibleRows(m, ui({ group: "owner" }));
    const keys = grouped.map(r => groupKey(r, "owner"));
    const seen = new Set<string>();
    keys.forEach((k, i) => { if (i && keys[i - 1] !== k) expect(seen.has(k)).toBe(false); seen.add(k); });
  });

  it("hides imported tickets in All open until Show imported is on", () => {
    const off = visibleRows(m, ui({ view: "all" }));
    const on = visibleRows(m, ui({ view: "all", imp: true }));
    expect(off.some(r => r.imported)).toBe(false);
    expect(on.length).toBe(off.length + m.rows.filter(r => r.imported && r.views.includes("all")).length);
  });

  it("round-trips the URL and leaves the defaults out", () => {
    expect(uiQuery(ui())).toBe("");
    const u = ui({ view: "noowner", text: "demo", over: true, sort: "id", dir: "asc", group: "cat", f: { status: ["claimed"], category: ["review", "site_bug"], owner: [], age: ["1to6"] } });
    const q = uiQuery(u);
    expect(parseUi(new URLSearchParams(q))).toEqual(u);
    expect(filtersOn(u)).toBe(true);
    expect(parseUi(new URLSearchParams("view=nope&sort=evil:x&age=forever")).view).toBe("human");
    expect(parseUi(new URLSearchParams("sort=evil:x&age=forever")).sort).toBe("wait");
    expect(parseUi(new URLSearchParams("age=forever")).f.age).toEqual([]);
  });

  it("says why a row left the view after Apply", () => {
    const before = visibleRows(m, ui());
    const target = before.find(r => !r.owner)!;
    const leila = { ...m.me, id: "U0LEILA01", name: "Leila Haddad", handle: "@copper-wren", label: "Leila Haddad", you: false };
    const after: BoardModel = { ...m, rows: m.rows.map(r => r.id === target.id ? { ...r, owner: leila, ownerState: "person" as const, status: "claimed", statusWord: "Claimed", views: r.views.filter(v => v !== "noowner"), facets: { ...r.facets, owner: leila.id } } : r) };
    const gone = leavers(visibleRows(m, ui({ view: "noowner" })), after, ui({ view: "noowner" }));
    expect(gone).toEqual([{ id: target.id, why: "claimed by Leila Haddad" }]);
  });
});
