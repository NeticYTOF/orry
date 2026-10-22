"use client";
/* The open tickets board (PLAN 4.1; redesign spec reports/orry-redesign-2026-10-20/SPEC.md "Board and ticket").
   The server renders it first with the whole model; filtering, sorting and grouping then run in the browser over
   the same rows with DATA's rowsFor() / facetCounts(). The URL keeps ?view=, ?q=, the filters and ?ticket= (replaceState).
   Every 30 s it polls /api/board?since=<version>; changes wait in the apply bar until Apply or R.
   Layout: header, stat strip, one toolbar, "Who has what", then the queue as a list of rows grouped under sticky
   headers. A ticket opens in one modal <dialog> (showModal()) at every width, full screen on phones. CSS: app/ui/board.css (qb-), the ticket itself app/ui/ticket.css (tk-). */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { BoardChanges, BoardModel, BoardRow, BoardView, TicketModel } from "@/lib/models";
import { Modal } from "@/components/ui/Modal";
import { PageHead } from "@/components/ui/PageHead";
import { setPreference } from "@/components/shell/preferences";
import { announce, toast } from "@/components/viz/live";
import { QueueShape } from "@/components/viz/QueueShape";
import {
  AGES, emptyUi, facetOptions, filtersOn, FIRST_TABS, GROUPS, groupKey, leavers, ownerText, SORTS, uiQuery, viewMenuCount, viewTotal, visibleRows,
  type BoardUi, type FacetKey, type GroupKey, type SortKey
} from "./boardState";
import { LimitChip, StatusChip } from "./chips";
import { Person } from "./people";
import { TicketView, type TicketNav, type TicketTab } from "./TicketView";

const PAGE = 50;
const FACETS: Array<{ key: FacetKey; label: string }> = [
  { key: "status", label: "Status" }, { key: "category", label: "Category" }, { key: "owner", label: "Owner" }, { key: "age", label: "Waiting" }
];
const MENUS = "details.menu[open]";

type Sheet = { id: number; data: TicketModel | null; err: string | null };

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
const modified = (e: ReactMouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
const bandOf = (r: BoardRow) => { const l = AGES.find(a => a.key === r.facets.age)?.label; return l ? `Waiting ${l.charAt(0).toLowerCase()}${l.slice(1)}` : "Waiting"; };

function Owner({ r, cls }: { r: BoardRow; cls: string }) {
  if (r.ownerState === "you") return <span className={cls + " me"}><b>You</b></span>;
  if (r.owner) return <span className={cls}><Person p={r.owner} /></span>;
  if (r.previousOwner) return <span className={cls + " none"}>Previously <Person p={r.previousOwner} /></span>;
  if (r.releasedBy) return <span className={cls + " none"}>Released by <Person p={r.releasedBy} /></span>;
  return <span className={cls + " none"}><span className="chip dash">No owner</span></span>;
}

function QText({ r }: { r: BoardRow }) {
  if (r.question != null) return <span className="qb-q">{r.question}</span>;
  if (r.sensitive && r.questionNote?.startsWith("Sensitive topic.")) return <span className="qb-q sens"><span className="chip dash">Sensitive</span> Open the ticket to read it.</span>;
  return <span className="qb-q withheld">{r.questionNote}</span>;
}

const Wait = ({ r, cls }: { r: BoardRow; cls?: string }) => (
  <time className={cls} dateTime={r.waitIso}>{r.atLeast ? "≥ " : ""}{r.waitText}</time>
);

/** The row link's name: number and question first, then what the row's other columns say. */
function rowLabel(r: BoardRow): string {
  const q = r.question ?? (r.sensitive ? "sensitive topic, open the ticket to read it" : r.questionNote ?? "");
  return [`Ticket ${r.id}: ${q}`, `waiting ${r.atLeast ? "at least " : ""}${r.waitText}`, r.statusWord, r.limitText, ownerText(r)].filter(Boolean).join(". ") + ".";
}

export function BoardClient({ initial, initialUi, roomy: roomy0 }: { initial: BoardModel; initialUi: BoardUi; roomy: boolean }) {
  const [model, setModel] = useState(initial);
  const [ui, setUi] = useState(initialUi);
  const [roomy, setRoomy] = useState(roomy0);
  const [pending, setPending] = useState<{ model: BoardModel; changes: BoardChanges } | null>(null);
  const [ghosts, setGhosts] = useState<Array<{ id: number; why: string }>>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [qsWidth, setQsWidth] = useState(360);
  const paneMode = false; // a ticket always opens as a modal; the side pane is retired
  const [tkTab, setTkTab] = useState<TicketTab>("details");
  const [qsView, setQsView] = useState<"chart" | "table">("chart");

  const rootRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLDivElement>(null);
  const qsRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDialogElement>(null);
  const dlgRef = useRef<HTMLDialogElement>(null);
  const fromRef = useRef<HTMLElement | null>(null);
  const versionRef = useRef(initial.version);
  const focusTitle = useRef(false);
  const tickets = useRef(new Map<number, TicketModel>());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const down = !!model.error || model.freshness.state === "not_connected" || model.freshness.state === "error" || model.freshness.state === "needs_update";
  const viewDef = model.views.find(v => v.key === ui.view) ?? model.views[0];
  const rows = useMemo(() => visibleRows(model, ui), [model, ui]);
  const total = useMemo(() => viewTotal(model, ui), [model, ui]);
  const facets = useMemo(() => facetOptions(model, ui), [model, ui]);
  const fOn = filtersOn(ui);
  const h = model.headline;
  const pane = paneMode && !!sheet;

  /* ---------- URL, nav count, pane or modal ---------- */
  /* a link with ?ticket=1042 opens that ticket (this runs before the URL effect below rewrites the address) */
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("ticket"));
    if (Number.isInteger(id) && id > 0 && !down) openSheet(id, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(uiQuery(ui).slice(1));
    if (sheet) q.set("ticket", String(sheet.id));
    const qs = q.toString();
    const url = "/board" + (qs ? "?" + qs : "") + window.location.hash;
    if (url !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, "", url);
  }, [ui, sheet]);
  useEffect(() => {
    const el = document.getElementById("navBoardCount");
    if (el) el.textContent = down ? "" : String(h.needHuman);
  }, [down, h.needHuman]);

  /* ---------- polling ---------- */
  const apply = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    setGhosts(leavers(visibleRows(model, ui), p.model, ui));
    setModel(p.model);
    versionRef.current = p.model.version;
    tickets.current.clear();
    setPending(null);
  }, [model, ui]);

  useEffect(() => {
    if (down) return;
    let etag: string | null = null;
    let stop = false;
    const tick = async () => {
      if (document.hidden || stop) return;
      try {
        const r = await fetch(`/api/board?view=human&since=${versionRef.current}`, { cache: "no-store", credentials: "same-origin", headers: etag ? { "If-None-Match": etag } : {} });
        setGhosts(g => (g.length ? [] : g));
        if (r.status === 304 || !r.ok) return;
        etag = r.headers.get("ETag");
        const j = await r.json() as { version: string; changes: BoardChanges | null; model: BoardModel };
        if (stop) return;
        if (j.version === versionRef.current) { setModel(j.model); return; }
        if (j.changes && j.changes.total > 0) {
          setPending({ model: j.model, changes: j.changes });
          if (j.changes.announce) announce(j.changes.announce);
        } else if (!pendingRef.current) {
          setModel(j.model); versionRef.current = j.version;
        } else {
          setPending({ model: j.model, changes: { ...pendingRef.current.changes } });
        }
      } catch { /* the next tick tries again */ }
    };
    const id = window.setInterval(tick, 30_000);
    return () => { stop = true; window.clearInterval(id); };
  }, [down]);

  /* the apply bar is sticky; group headers and the pane stick just under it (--qb-top) */
  useEffect(() => {
    const bar = applyRef.current, root = rootRef.current;
    if (!bar || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--qb-top", `${bar.offsetHeight ? bar.offsetHeight + 8 : 0}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [down]);

  /* ---------- the ticket dialog ---------- */
  const loadTicket = useCallback((id: number) => {
    const hit = tickets.current.get(id);
    if (hit) { setSheet({ id, data: hit, err: null }); return; }
    setSheet(s => ({ id, data: s?.id === id ? s.data : null, err: null }));
    fetch(`/api/tickets/${id}`, { cache: "no-store", credentials: "same-origin" })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 404 ? "This ticket is not available." : j.message ?? "The ticket could not be loaded.");
        tickets.current.set(id, j as TicketModel);
        setSheet(s => (s && s.id === id ? { id, data: j as TicketModel, err: null } : s));
      })
      .catch((e: Error) => setSheet(s => (s && s.id === id ? { ...s, err: e.message } : s)));
  }, []);

  const openSheet = useCallback((id: number, from?: HTMLElement | null, noFocus = false) => {
    fromRef.current = from ?? (document.activeElement as HTMLElement | null);
    focusTitle.current = !noFocus;
    loadTicket(id);
  }, [loadTicket]);

  /* move focus to the ticket's heading once it is on screen (the loading heading is replaced) */
  useEffect(() => {
    if (!sheet || !focusTitle.current || (!sheet.data && !sheet.err)) return;
    focusTitle.current = false;
    requestAnimationFrame(() => (document.getElementById("shTitle") as HTMLElement | null)?.focus({ preventScroll: true }));
  }, [sheet]);

  const closeSheet = useCallback((): boolean => {
    if (!sheet) return false;
    const id = sheet.id;
    setSheet(null);
    requestAnimationFrame(() => {
      const vis = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find(el => el.offsetParent !== null);
      const back = vis(`#queue [data-open="${id}"]`) ?? fromRef.current;
      back?.focus?.();
    });
    return true;
  }, [sheet]);

  /* Pane: show() keeps the page live (no inert, no scroll lock, Esc comes from the keydown handler below).
     Modal: showModal() makes the page inert, traps Tab and gives the cancel event. Switching width swaps the mode. */
  useEffect(() => {
    const d = dlgRef.current;
    if (!d) return;
    if (!sheet) { if (d.open) d.close(); return; }
    const isModal = d.matches(":modal");
    if (d.open && isModal === !paneMode) return;
    const moving = d.open;
    if (d.open) d.close();
    if (paneMode) d.show(); else d.showModal();
    if (moving) requestAnimationFrame(() => (document.getElementById("shTitle") as HTMLElement | null)?.focus({ preventScroll: true }));
  }, [sheet, paneMode]);

  /* the pane's height: from where it starts on screen down to the window's foot, so its footer is always visible */
  useEffect(() => {
    if (!pane) return;
    const d = dlgRef.current, split = splitRef.current, main = document.getElementById("mainCol");
    if (!d || !split) return;
    let raf = 0;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const stick = 16 + (parseFloat(getComputedStyle(rootRef.current!).getPropertyValue("--qb-top")) || 0);
        const top = Math.max(split.getBoundingClientRect().top, stick);
        d.style.setProperty("--qb-pane-h", `${Math.max(320, window.innerHeight - top - 16)}px`);
      });
    };
    fit();
    main?.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    return () => { cancelAnimationFrame(raf); main?.removeEventListener("scroll", fit); window.removeEventListener("resize", fit); };
  }, [pane, pending]);

  /* keep the open ticket's row in sight while J / K step through the list */
  useEffect(() => {
    if (!sheet) return;
    document.querySelector<HTMLElement>(`#queue [data-id="${sheet.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sheet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- state changes ---------- */
  const update = (fn: (u: BoardUi) => BoardUi) => { setUi(u => fn({ ...u, f: { ...u.f } })); setShown(PAGE); };
  const setView = (v: BoardView, focus = true) => {
    setGhosts([]);
    update(u => ({ ...u, view: v }));
    rootRef.current?.querySelectorAll<HTMLDetailsElement>(MENUS).forEach(d => { d.open = false; });
    if (focus) requestAnimationFrame(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(`#tabs [data-view="${v}"]`)).find(x => x.offsetParent !== null)
        ?? document.querySelector<HTMLElement>("#tabs .qb-more > summary");
      el?.focus();
    });
  };
  const clearFilters = () => update(u => ({ ...emptyUi(u.view), sort: u.sort, dir: u.dir, group: u.group, imp: u.imp }));
  const toggleFacet = (k: FacetKey, v: string, on: boolean) => update(u => { u.f[k] = on ? [...u.f[k], v] : u.f[k].filter(x => x !== v); return u; });
  const filterOwner = (key: string) => update(u => {
    const only = u.f.owner.length === 1 && u.f.owner[0] === key;
    u.f.owner = only ? [] : [key];
    if (!only && u.view !== "human" && u.view !== "all") u.view = "human";
    return u;
  });
  const setSort = (k: SortKey, d: "asc" | "desc") => update(u => ({ ...u, sort: k, dir: d }));
  const toggleRoomy = () => { const next = !roomy; setRoomy(next); void setPreference({ density: next ? "roomy" : "standard" }); };

  /* ---------- menus: one open at a time, close on outside click, keep the popover inside the window ---------- */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const click = (e: MouseEvent) => {
      root.querySelectorAll<HTMLDetailsElement>(MENUS).forEach(d => { if (!d.contains(e.target as Node)) d.open = false; });
    };
    const toggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.matches?.("details.menu") || !d.open) return;
      root.querySelectorAll<HTMLDetailsElement>(MENUS).forEach(x => { if (x !== d) x.open = false; });
      const pop = d.querySelector<HTMLElement>(".menu-pop");
      if (!pop) return;
      const lim = document.documentElement.clientWidth - 12;
      d.classList.remove("qb-flip");
      const r = pop.getBoundingClientRect();
      if (r.right > lim || r.left < 12) {
        d.classList.add("qb-flip");
        const r2 = pop.getBoundingClientRect();
        if (r2.left < 12 || r2.right > lim) d.classList.remove("qb-flip");
      }
    };
    document.addEventListener("click", click);
    root.addEventListener("toggle", toggle, true);
    return () => { document.removeEventListener("click", click); root.removeEventListener("toggle", toggle, true); };
  }, []);

  /* ---------- keyboard: one stack, Escape closes the top layer first ---------- */
  const sheetIdx = sheet ? rows.findIndex(r => r.id === sheet.id) : -1;
  const step = (d: number) => { const r = rows[sheetIdx + d]; if (r) openSheet(r.id, fromRef.current, false); };
  const stateRef = useRef({ rows, sheet, apply, closeSheet, openSheet, model, setView, step, paneMode });
  stateRef.current = { rows, sheet, apply, closeSheet, openSheet, model, setView, step, paneMode };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      const root = rootRef.current;
      if (e.key === "Escape") {
        const f = root?.querySelector<HTMLDetailsElement>(MENUS);
        if (f) { f.open = false; f.querySelector<HTMLElement>("summary")?.focus(); e.preventDefault(); return; }
        if (document.querySelector("dialog.dlg[open]")) return;   // shortcuts, Workload: the native dialog closes itself
        if (document.getElementById("nav")?.dataset.open === "true") return;
        /* the pane is a non-modal dialog: it gets no cancel event, so Esc is handled here (the modal's too) */
        if (s.closeSheet()) e.preventDefault();
        return;
      }
      const t = e.target as HTMLElement;
      const tag = (t.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog.dlg[open]")) return;
      /* a ticket is open: J / K step through the list. As a modal, only O also acts; as a pane the page stays live. */
      if (s.sheet) {
        if (e.key === "j" || e.key === "k") { e.preventDefault(); s.step(e.key === "j" ? 1 : -1); return; }
        if (!s.paneMode && e.key !== "o") return;
      }
      const ids = Array.from(document.querySelectorAll<HTMLElement>("#queue .qb-link")).filter(b => b.offsetParent !== null);
      const cur = ids.indexOf(document.activeElement as HTMLElement);
      const k = e.key;
      if ((k === "j" || k === "k" || ((k === "ArrowDown" || k === "ArrowUp") && cur > -1)) && ids.length && !isPhone()) {
        e.preventDefault();
        const dn = k === "j" || k === "ArrowDown";
        const i = Math.max(0, Math.min(ids.length - 1, cur === -1 ? 0 : cur + (dn ? 1 : -1)));
        ids[i].focus();
        return;
      }
      if (k === "o") {
        const id = cur > -1 ? Number(ids[cur].dataset.open) : s.sheet?.id;
        const row = s.model.rows.find(r => r.id === id);
        if (row?.slackUrl) window.open(row.slackUrl, "_blank", "noopener,noreferrer");
        else if (id) toast(`Ticket #${id} has no Slack link.`);
        return;
      }
      if (k === "/") { e.preventDefault(); document.getElementById("q")?.focus(); return; }
      if (k === "r" || k === "R") { s.apply(); return; }
      if (k === "?") { keysRef.current?.showModal(); return; }
      if (/^[1-8]$/.test(k)) { const v = s.model.views.find(x => x.shortcut === Number(k)); if (v) s.setView(v.key); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- queue shape size ---------- */
  useEffect(() => {
    const el = qsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setQsWidth(el.clientWidth || 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- pieces ---------- */
  const openLink = (id: number, cls: string, label: string | undefined, children: ReactNode, href: string) => (
    <a className={cls} href={href} data-open={id} aria-label={label}
      onClick={e => { if (modified(e)) return; e.preventDefault(); openSheet(id, e.currentTarget); }}>{children}</a>
  );

  const tab = (key: BoardView, cls?: string) => {
    const v = model.views.find(x => x.key === key)!;
    return (
      <a key={key} className={cls} href={`/board${key === "human" ? "" : `?view=${key}`}`} data-view={key} aria-current={ui.view === key ? "page" : undefined}
        onClick={e => { if (modified(e)) return; e.preventDefault(); setView(key); }}>
        <span>{v.tabLabel}</span>{down ? null : <span className="n">{v.count}</span>}
      </a>
    );
  };
  const rest = model.views.filter(v => !FIRST_TABS.includes(v.key));
  const restOn = rest.find(v => v.key === ui.view);

  const sortName = SORTS.find(s => s.value === `${ui.sort}:${ui.dir}`)?.label ?? "Waiting, oldest first";
  const shownRows = rows.slice(0, shown);
  const noOwnerOn = ui.f.owner.length === 1 && ui.f.owner[0] === "_none";
  const mineNow = model.rows.filter(r => r.ownerState === "you" && r.views.includes("human")).sort((a, b) => b.waitMs - a.waitMs);
  const vmCount = viewMenuCount(ui, roomy);

  /* ---------- empty, error and offline states ---------- */
  let statePanel: ReactNode = null;
  if (down) {
    const e = model.error;
    statePanel = (
      <div className="state" role="status">
        <span className="mole away" aria-hidden="true" />
        <div>
          <h2>{e?.message ?? "Orry's data is not connected yet."}</h2>
          {e?.detail ? <p>{e.detail}</p> : null}
          {e?.gap ? <p>Needs Orry update {e.gap}.</p> : null}
          {model.role === "organizer" || e?.retry ? (
            <div className="btn-row blk">
              {model.role === "organizer" ? <a className="btn sm" href="/config">Open Config check</a> : null}
              {e?.retry ? <button className="btn sm" type="button" onClick={() => window.location.reload()}>Try again</button> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  } else if (model.freshness.hideRows) {
    statePanel = (
      <div className="state">
        <span className="mole away" aria-hidden="true" />
        <div><h2>Orry is offline.</h2><p>{model.freshness.banner}</p></div>
      </div>
    );
  } else if (model.empty && !fOn && (model.empty.kind === "no_open" || ui.view === "human")) {
    const em = model.empty;
    statePanel = (
      <div className="state">
        <span className="mole sleeping" aria-hidden="true" />
        <div>
          <h2>{em.title}</h2>
          <p>{em.kind === "no_open" ? <><span lang="de">Passt</span> (all good).</> : em.body}</p>
          {em.links.length ? <div className="btn-row blk">{em.links.map(l => <button key={l.view} className="btn sm" type="button" data-view={l.view} onClick={() => setView(l.view)}>{l.label} ({l.count})</button>)}</div> : null}
        </div>
      </div>
    );
  } else if (rows.length === 0) {
    statePanel = (
      <div className="state">
        <span className="mole idle" aria-hidden="true" />
        <div>
          <h2>No tickets match.</h2>
          <p>{fOn ? "The filters hide every ticket in this view." : "This view is empty right now."}</p>
          {fOn ? <div className="btn-row blk"><button className="btn sm" type="button" onClick={clearFilters}>Clear filters</button></div> : null}
        </div>
      </div>
    );
  }

  /* ---------- the queue: rows under group headers (an explicit grouping, else wait bands when sorted by wait) ---------- */
  const byBand = !ui.group && ui.sort === "wait";
  const gk = (r: BoardRow) => (ui.group ? groupKey(r, ui.group) : byBand ? bandOf(r) : "");
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(gk(r), (counts.get(gk(r)) ?? 0) + 1);
  const groups: Array<{ key: string; rows: BoardRow[] }> = [];
  for (const r of shownRows) {
    const k = gk(r);
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }

  const row = (r: BoardRow) => {
    const sel = sheet?.id === r.id;
    return (
      <li key={r.id} data-id={r.id} className={"qb-row" + (r.limit === "over" ? " over" : "") + (sel ? " sel" : "")}>
        <a className="qb-link" href={r.href} data-open={r.id} aria-label={rowLabel(r)} aria-current={sel ? "true" : undefined}
          onClick={e => { if (modified(e)) return; e.preventDefault(); openSheet(r.id, e.currentTarget); }}>
          <Wait r={r} cls="qb-wait" />
          <span className="qb-id">#{r.id}</span>
          <QText r={r} />
          <span className="qb-meta">
            <span className="qb-id-n">#{r.id}</span>
            <span className="qb-cat">{r.categoryLabel}</span>
            <StatusChip status={r.status} word={r.statusWord} sprite={r.statusSprite} cls={r.statusClass} />
            <LimitChip limit={r.limit} text={r.limitText} note={r.limitNote} />
            {r.flags.map(f => <span className="chip quiet" key={f.key}>{f.text}</span>)}
            <Owner r={r} cls="qb-own-n" />
          </span>
          <Owner r={r} cls="qb-own" />
        </a>
        <span className="qb-act">
          {r.slackUrl
            ? <a className="btn sm qb-slack" href={r.slackUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ticket ${r.id} in Slack, new tab`}><span className="t">Slack</span> <span className="ar" aria-hidden="true">↗</span></a>
            : <span className="qb-noslack" title="No Slack link for this ticket">No link</span>}
        </span>
      </li>
    );
  };

  const changeText = pending?.changes.text.replace(/\s*Press R or select Apply\.\s*$/, "") ?? "";
  const shapes = model.queueShape[ui.view] ?? [];
  const limitText = h.limitLabel.replace(/^site limit /, "").replace(/^bot SLA /, "");
  const oldest = h.oldest;
  const facetLabel = (k: FacetKey, v: string) => facets[k].find(o => o.value === v)?.label ?? (k === "age" ? AGES.find(a => a.key === v)?.label : null) ?? v;
  const closeDlg = (el: HTMLElement) => el.closest("dialog")?.close();
  const busy = model.load.filter(i => i.n > 0 || i.key === "_none");
  const free = model.load.filter(i => i.n === 0 && i.key !== "_none");
  const owners = busy.filter(i => i.key !== "_none").length;

  /* ---------- the Workload modal: replies, who has what, yours now, the queue shape ---------- */
  const workload = (
    <div className="qb-wl">
      <div className="qb-wl-stats" role="group" aria-label="Replies">
        <div className="stat">
          <span className="stat-k">Typical first reply</span>
          <span className="stat-v sm">{h.typicalReply ? h.typicalReply.text : "Not enough data"}</span>
          {h.typicalReply ? <span className="stat-s">{h.typicalReply.note}</span> : null}
        </div>
        <div className="stat"><span className="stat-k">Waiting for a first reply</span><span className="stat-v sm">{h.waitingFirstReply}</span></div>
        <div className="stat"><span className="stat-k">In progress</span><span className="stat-v sm">{h.inProgress}</span></div>
      </div>

      <section className="qb-wl-sec" aria-labelledby="h-load">
        <h3 className="qb-wl-h" id="h-load">Who has what</h3>
        <ul className="qb-load" id="loadList">
          {busy.map(i => {
            const on = ui.f.owner.length === 1 && ui.f.owner[0] === i.key;
            return (
              <li key={i.key}>
                <button className={"qb-lchip" + (i.key === "_none" ? " none" : "")} type="button" data-load={i.key} aria-pressed={on}
                  aria-label={`${i.label}: ${i.n} need a human${i.oldestText ? `, oldest waiting ${i.oldestText}` : ""}. ${on ? "Clear the filter" : "Filter the board to this owner"}`}
                  onClick={e => { filterOwner(i.key); closeDlg(e.currentTarget); }}>
                  <span className="nm">{i.person ? <Person p={i.person} /> : i.label}{i.you ? <i className="you">you</i> : null}</span>
                  <span className="c">{i.n}</span>
                  {i.oldestText ? <span className="o">{i.line.replace(/^oldest /, "")}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {free.length ? (
          <p className="qb-free">
            <span className="kicker">Free now</span>
            <span>{free.map((i, n) => <span key={i.key}>{n ? ", " : ""}{i.person ? <Person p={i.person} /> : i.label}{i.you ? <i className="you">you</i> : null}</span>)}</span>
          </p>
        ) : null}
      </section>

      {mineNow.length ? (
        <section className="qb-wl-sec" aria-labelledby="h-yours">
          <h3 className="qb-wl-h" id="h-yours">Yours now <span className="qb-wl-n">{mineNow.length}</span></h3>
          <ul className="qb-mine">
            {mineNow.map(r => (
              <li key={r.id}>
                <a className="lnk" href={r.href} data-open={r.id} aria-label={`Ticket ${r.id}, yours, open details`}
                  onClick={e => { if (modified(e)) return; e.preventDefault(); closeDlg(e.currentTarget); openSheet(r.id, null); }}>#{r.id}</a>
                <Wait r={r} />
                {r.limit === "over" ? <span className="chip over">Over</span> : null}
                <span className="qb-mine-st">{r.statusWord}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="qb-wl-sec" aria-labelledby="h-qs">
        <div className="qb-wl-row">
          <h3 className="qb-wl-h" id="h-qs">Queue shape <span className="qb-wl-n">{viewDef.label}</span></h3>
          <div className="tabs qb-seg" role="group" aria-label="Show the queue shape as">
            <button type="button" aria-pressed={qsView === "chart"} onClick={() => setQsView("chart")}>Chart</button>
            <button type="button" aria-pressed={qsView === "table"} onClick={() => setQsView("table")}>Table</button>
          </div>
        </div>
        <div className="qb-qs" id="qs" ref={qsRef}>
          {shapes.length ? <QueueShape buckets={shapes} viewLabel={viewDef.label} limitText={limitText} width={qsWidth} view={qsView} /> : <p className="qb-none">No open tickets in this view.</p>}
        </div>
      </section>
    </div>
  );

  return (
    <div id="board" className="qb" tabIndex={-1} ref={rootRef}>
      <PageHead
        kicker="Help desk"
        title="Open tickets"
        note={down
          ? <span id="hWord">Not connected right now.</span>
          : <><b className="qb-hn" id="hNum">{h.needHuman}</b> <span id="hWord">{h.word}</span>.</>}
        side={<>
          <span className={"fresh" + (model.freshness.state !== "live" ? " stale" : "")} id="fresh" aria-live="off">{model.freshness.tag}</span>
          <button className="btn sm" type="button" id="keysBtn" aria-haspopup="dialog" onClick={() => keysRef.current?.showModal()} aria-keyshortcuts="?">Shortcuts <kbd aria-hidden="true">?</kbd></button>
        </>}
      />

      {!down && model.freshness.banner && !model.freshness.hideRows ? <p className="banner qb-banner" id="staleBanner" role="status">{model.freshness.banner}</p> : null}

      {!down ? (
        <div className="stats qb-stats" id="ledger" role="group" aria-label="Board numbers, whole view">
          <div className="stat">
            <span className="stat-k">Need a human</span>
            <span className="stat-v">{h.needHuman}</span>
            <span className="stat-s">{h.waitingFirstReply} waiting for a first reply</span>
          </div>
          <button className="stat" type="button" id="overBtn" aria-pressed={ui.over} onClick={() => update(u => ({ ...u, over: !u.over }))}>
            <span className="stat-k">Over the limit</span>
            <span className="stat-v">{h.over}</span>
            <span className="stat-s">Limit {limitText} · {h.near} near</span>
          </button>
          <button className="stat" type="button" id="noOwnerBtn" aria-pressed={noOwnerOn} onClick={() => filterOwner("_none")}>
            <span className="stat-k">No owner</span>
            <span className="stat-v">{h.noOwner}</span>
            <span className="stat-s">{noOwnerOn ? "Showing only these" : "Show only these"}</span>
          </button>
          <div className="stat">
            <span className="stat-k">Oldest wait</span>
            {oldest ? (
              <>
                <span className="stat-v sm"><time dateTime={oldest.waitIso}>{oldest.atLeast ? "≥ " : ""}{oldest.waitText}</time></span>
                <span className="stat-s">{openLink(oldest.id, "lnk", `Oldest wait, ticket ${oldest.id}, open details`, `#${oldest.id}`, oldest.href)}</span>
              </>
            ) : <><span className="stat-v sm">None</span><span className="stat-s">Nobody is waiting</span></>}
          </div>
        </div>
      ) : null}

      {/* ---------- list and pane ---------- */}
      <div className={"qb-split" + (pane ? " has-pane" : "")} id="split" ref={splitRef}>
        <div className="qb-main" id="boardList">
          {/* ---------- the one toolbar ---------- */}
          <div className="qb-bar" id="tools">
            <div className="qb-bar-1">
              <nav className="tabs qb-tabs" id="tabs" aria-label="Board views">
                {FIRST_TABS.map(k => tab(k))}
                <details className="menu left qb-more">
                  <summary aria-current={restOn ? "page" : undefined} className={restOn ? "on" : undefined}>
                    <span>{restOn ? restOn.tabLabel : "More views"}</span>{restOn && !down ? <span className="n">{restOn.count}</span> : null}<span className="ar" aria-hidden="true">▾</span>
                  </summary>
                  <div className="menu-pop qb-views">
                    {rest.map(v => tab(v.key, "btn sm"))}
                  </div>
                </details>
              </nav>
              {!down ? (
                <div className="qb-search">
                  <label className="vh" htmlFor="q">Search the tickets by text or #number</label>
                  <input id="q" type="search" placeholder="Search or #number" autoComplete="off" aria-keyshortcuts="/" value={ui.text} onChange={e => update(u => ({ ...u, text: e.target.value.trimStart() }))} />
                  <kbd aria-hidden="true">/</kbd>
                </div>
              ) : null}
            </div>

            {!down ? (
              <div className="qb-bar-2">
                {FACETS.map(fd => {
                  const n = ui.f[fd.key].length;
                  return (
                    <details key={fd.key} className="menu left qb-f" data-facet={fd.key}>
                      <summary className={"btn sm" + (n ? " qb-on" : "")}>
                        {fd.label}{n ? <span className="qb-n"><span className="vh">, </span>{n}<span className="vh"> selected</span></span> : null}<span className="ar" aria-hidden="true">▾</span>
                      </summary>
                      <div className="menu-pop qb-pop" role="group" aria-label={fd.label}>
                        {facets[fd.key].map(o => (
                          <label key={o.value} className="qb-opt">
                            <input type="checkbox" value={o.value} checked={ui.f[fd.key].includes(o.value)} onChange={e => toggleFacet(fd.key, o.value, e.target.checked)} />
                            <span>{o.label}</span><span className="qb-ct">{o.n}</span>
                          </label>
                        ))}
                      </div>
                    </details>
                  );
                })}
                <div className="qb-bar-end">
                  <Modal label={<>Workload <span className="qb-n"><span className="vh">, </span>{owners}<span className="vh"> people with tickets</span></span></>} title="Workload" wide triggerClass="btn sm qb-wl-btn">
                    {workload}
                  </Modal>
                  <details className="menu qb-f qb-display" id="viewMenu">
                    <summary className={"btn sm" + (vmCount ? " qb-on" : "")}>
                      Display{vmCount ? <span className="qb-n" id="viewOn"><span className="vh">, </span>{vmCount}<span className="vh"> changed</span></span> : null}<span className="ar" aria-hidden="true">▾</span>
                    </summary>
                    <div className="menu-pop qb-pop" role="group" aria-label="Display options">
                      <div className="field">
                        <label htmlFor="sortSel">Sort</label>
                        <select id="sortSel" value={`${ui.sort}:${ui.dir}`} onChange={e => { const [k, d] = e.target.value.split(":"); setSort(k as SortKey, d as "asc" | "desc"); }}>
                          {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                          {!SORTS.some(s => s.value === `${ui.sort}:${ui.dir}`) ? <option value={`${ui.sort}:${ui.dir}`}>{ui.sort}, {ui.dir === "asc" ? "ascending" : "descending"}</option> : null}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="groupSel">Group</label>
                        <select id="groupSel" value={ui.group} onChange={e => update(u => ({ ...u, group: e.target.value as GroupKey }))}>
                          {GROUPS.map(g => <option key={g.value} value={g.value}>{g.value ? g.label : "By waiting time"}</option>)}
                        </select>
                      </div>
                      <div className="qb-togs">
                        <button className="qb-tog" type="button" id="togOver" aria-pressed={ui.over} onClick={() => update(u => ({ ...u, over: !u.over }))}>Over the limit only</button>
                        <button className="qb-tog" type="button" id="togImp" aria-pressed={ui.imp} onClick={() => update(u => ({ ...u, imp: !u.imp }))}>Show imported</button>
                        <button className="qb-tog" type="button" id="togDensity" aria-pressed={roomy} onClick={toggleRoomy}>Roomy rows</button>
                      </div>
                    </div>
                  </details>
                </div>

                {fOn ? (
                  <ul className="qb-chips" aria-label="Active filters">
                    {ui.text ? <li><button className="qb-fchip" type="button" aria-label={`Remove the search for ${ui.text}`} onClick={() => update(u => ({ ...u, text: "" }))}>Text: {ui.text} <span aria-hidden="true">×</span></button></li> : null}
                    {ui.over ? <li><button className="qb-fchip" type="button" aria-label="Remove the filter Over the limit" onClick={() => update(u => ({ ...u, over: false }))}>Over the limit <span aria-hidden="true">×</span></button></li> : null}
                    {FACETS.flatMap(fd => ui.f[fd.key].map(v => (
                      <li key={`${fd.key}:${v}`}>
                        <button className="qb-fchip" type="button" aria-label={`Remove the filter ${fd.label}: ${facetLabel(fd.key, v)}`} onClick={() => toggleFacet(fd.key, v, false)}>
                          {fd.label}: {facetLabel(fd.key, v)} <span aria-hidden="true">×</span>
                        </button>
                      </li>
                    )))}
                    <li><button className="txt-link" type="button" id="clearBtn" onClick={clearFilters}>Clear filters</button></li>
                  </ul>
                ) : null}
              </div>
            ) : null}

            {!down ? <p className="qb-result" id="result" aria-live="polite">Showing {rows.length} of {total} in {viewDef.label}.</p> : null}
          </div>

          {!down ? (
            <div className="qb-apply" id="applybar" role="status" ref={applyRef} hidden={!pending}>
              <span id="applyText">{changeText}</span>
              <button className="btn pri sm" type="button" id="applyBtn" aria-keyshortcuts="r" onClick={apply}>Apply <kbd aria-hidden="true">R</kbd></button>
            </div>
          ) : null}

          <div id="statePanel">{statePanel}</div>
          {!statePanel ? (
            <div className={"qb-list" + (roomy ? " roomy" : "")} id="queue" role="region" aria-labelledby="h-queue">
              <h2 className="vh" id="h-queue">{viewDef.label}, sorted by {sortName.toLowerCase()}. Select a ticket to open it.</h2>
              {groups.map((g, gi) => (
                <div className="qb-grp" key={g.key || "all"} role={g.key ? "group" : undefined} aria-labelledby={g.key ? `gh-${gi}` : undefined}>
                  {g.key ? <h3 className="qb-gh" id={`gh-${gi}`}><span>{g.key}</span><span className="n">{counts.get(g.key) ?? g.rows.length}</span></h3> : null}
                  <ol className="qb-rows">{g.rows.map(row)}</ol>
                </div>
              ))}
              {ghosts.length ? <ul className="qb-ghosts">{ghosts.map(g => <li key={`x-${g.id}`}>#{g.id} left this view: {g.why}</li>)}</ul> : null}
              {rows.length > shown ? (
                <div className="qb-pager">
                  <p>Showing {shown} of {rows.length}.</p>
                  <button className="btn sm" type="button" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <dialog className="qb-dlg" id="sheet" ref={dlgRef} aria-labelledby="shTitle"
          onCancel={e => { e.preventDefault(); closeSheet(); }}
          onClick={e => { if (e.target === e.currentTarget && e.currentTarget.matches(":modal")) closeSheet(); }}>
          {sheet ? (sheet.data ? (
            <TicketView key={sheet.id} t={sheet.data} mode="sheet" onClose={() => { closeSheet(); }} tab={tkTab} onTab={setTkTab}
              nav={sheetIdx >= 0 ? { pos: sheetIdx + 1, total: rows.length, onPrev: sheetIdx > 0 ? () => step(-1) : null, onNext: sheetIdx < rows.length - 1 ? () => step(1) : null } satisfies TicketNav : undefined} />
          ) : (
            <>
              <header className="tk-head">
                <p className="kicker tk-kick">Ticket</p>
                <div className="tk-tools"><button className="btn sm" type="button" onClick={() => closeSheet()} aria-label={`Close ticket ${sheet.id}`}>Close</button></div>
                <h2 className="tk-title" id="shTitle" tabIndex={-1}>Ticket <span className="num">#{sheet.id}</span></h2>
              </header>
              <div className="tk-body">
                {sheet.err
                  ? <div className="state-note" role="alert"><p>{sheet.err}</p><p><a className="lnk" href={`/tickets/${sheet.id}`}>Open the ticket page</a></p></div>
                  : <p className="tk-none" aria-busy="true">Loading ticket #{sheet.id}.</p>}
              </div>
            </>
          )) : null}
        </dialog>
      </div>

      <dialog className="dlg" id="keys" aria-labelledby="keysTitle" ref={keysRef} onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
        <div className="dlg-head">
          <h2 id="keysTitle">Shortcuts</h2>
          <form method="dialog"><button className="btn sm" type="submit">Close</button></form>
        </div>
        <div className="dlg-b">
          <table className="tbl qb-keys">
            <thead><tr><th scope="col">Key</th><th scope="col">Does</th></tr></thead>
            <tbody>
              <tr><th scope="row"><kbd>j</kbd> <kbd>k</kbd></th><td>Next and previous ticket</td></tr>
              <tr><th scope="row"><kbd>Enter</kbd></th><td>Open the ticket</td></tr>
              <tr><th scope="row"><kbd>o</kbd></th><td>Open in Slack</td></tr>
              <tr><th scope="row"><kbd>/</kbd></th><td>Search</td></tr>
              <tr><th scope="row"><kbd>1</kbd> to <kbd>8</kbd></th><td>Switch view</td></tr>
              <tr><th scope="row"><kbd>r</kbd></th><td>Apply waiting updates</td></tr>
              <tr><th scope="row"><kbd>Esc</kbd></th><td>Close the ticket or menu</td></tr>
            </tbody>
          </table>
        </div>
      </dialog>
    </div>
  );
}
