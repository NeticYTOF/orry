"use client";
/* The closed tickets list (PLAN 4.4, 4.17). The server sends every finished ticket of the week; the tabs (who closed it),
   the search box and the Filters dialog (week, person, outcome, imports) narrow it here, and ?by=, ?who=, ?outcome=, ?q=
   stay in the URL. 15 rows at a time. */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClosedBy, ClosedModel, ClosedRow } from "@/lib/models";
import { Person, WhoRef } from "@/components/board/people";
import { FreshBanner } from "@/components/stats/common";
import { ImportToggle } from "@/components/stats/ImportToggle";
import { Modal } from "@/components/ui/Modal";
import { PageHead } from "@/components/ui/PageHead";

type Filters = { by: ClosedBy | "all"; who: string; outcome: "" | "res" | "no"; q: string };
const STEP = 15;

const CELLS: Array<{ by: ClosedBy | "all"; label: string; aria: string }> = [
  { by: "all", label: "All", aria: "closed tickets" },
  { by: "orry", label: "Orry", aria: "closed by Orry" },
  { by: "helper", label: "Helpers", aria: "closed by a helper" },
  { by: "participant", label: "Participants", aria: "closed by the participant" },
  { by: "person", label: "Person or macro", aria: "closed by a person or macro" }
];
const OUTCOME = { res: "Resolved", no: "Closed without resolution" } as const;

export function closedPass(r: ClosedRow, f: Filters): boolean {
  if (f.by !== "all" && r.group !== f.by) return false;
  if (f.who && r.credited?.id !== f.who && !(r.closedBy.kind === "person" && r.closedBy.person?.id === f.who)) return false;
  if (f.outcome === "res" && !r.resolved) return false;
  if (f.outcome === "no" && r.resolved) return false;
  if (f.q) {
    const s = f.q.toLowerCase().replace(/^#/, "");
    const who = r.closedBy.kind === "helper" ? `${r.closedBy.person.label} ${r.closedBy.person.handle ?? ""}` : r.closedBy.kind === "person" ? r.closedBy.person?.label ?? "" : r.closedBy.kind;
    const hay = `${r.id} ${r.question ?? ""} ${r.categoryLabel} ${who}`.toLowerCase();
    if (!hay.includes(s)) return false;
  }
  return true;
}

function ClosedByCell({ r }: { r: ClosedRow }) {
  const c = r.closedBy;
  if (c.kind === "orry") return <span className="who by-orry"><b>ORRY</b><small>{c.rule}</small></span>;
  if (c.kind === "helper") return <WhoRef p={c.person} />;
  if (c.kind === "participant") return <span className="who"><b>{c.text}</b><small>{c.sub}</small></span>;
  return <span className="who"><b>{c.person ? <Person p={c.person} /> : "A person or macro"}</b><small>{c.sub}</small></span>;
}

export function ClosedClient({ m, initial, imported = false }: { m: ClosedModel; initial: Filters; imported?: boolean }) {
  const [f, setF] = useState<Filters>(initial);
  const [d, setD] = useState({ who: initial.who, outcome: initial.outcome });
  const [shown, setShown] = useState(STEP);
  const rows = useMemo(() => m.rows.filter(r => closedPass(r, f)), [m.rows, f]);
  const wk = m.week.label.replace(/^Week\s+/, "");
  const personLabel = (id: string) => m.people.find(p => p.id === id)?.person.label ?? id;
  const active = (f.who ? 1 : 0) + (f.outcome ? 1 : 0) + (imported ? 1 : 0);
  const any = f.by !== "all" || !!f.who || !!f.outcome || !!f.q;

  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(f);
  latest.current = f;
  /* Closing the dialog without Apply drops the unsaved choices (the "close" event does not bubble, so listen on the dialog). */
  useEffect(() => {
    const dlg = box.current?.closest("dialog");
    if (!dlg) return;
    const reset = () => setD({ who: latest.current.who, outcome: latest.current.outcome });
    dlg.addEventListener("close", reset);
    return () => dlg.removeEventListener("close", reset);
  }, []);
  useEffect(() => { setD({ who: f.who, outcome: f.outcome }); }, [f.who, f.outcome]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const set = (k: string, v: string) => { if (v) q.set(k, v); else q.delete(k); };
    set("by", f.by === "all" ? "" : f.by); set("who", f.who); set("outcome", f.outcome); set("q", f.q);
    const s = q.toString();
    const url = `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash}`;
    if (url !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, "", url);
  }, [f]);

  const change = (p: Partial<Filters>) => { setF(x => ({ ...x, ...p })); setShown(STEP); };
  /** Another week keeps the filters and the import switch. */
  const weekHref = (week: string) => {
    const q = new URLSearchParams({ week });
    if (imported) q.set("imported", "1");
    if (f.by !== "all") q.set("by", f.by);
    if (f.who) q.set("who", f.who);
    if (f.outcome) q.set("outcome", f.outcome);
    if (f.q) q.set("q", f.q);
    return `/closed?${q}`;
  };

  return (
    <>
      <PageHead
        kicker="Closed tickets"
        title={<><span className="vh">Closed tickets: </span><span className="big" id="bigN">{rows.length}</span> <span id="bigLbl">{rows.length === m.total ? `closed in week ${wk}` : "match your filters"}</span></>}
        side={<>
          {m.week.chip ? <p className="fresh prov">{m.week.chip}</p> : null}
          <p className={"fresh" + (m.freshness.state !== "live" ? " stale" : "")} tabIndex={0} data-tip={`Closed tickets read from Orry's ticket rows${m.freshness.at ? ` at ${m.freshness.at.slice(11, 16)} UTC` : ""}. Cached for 10 minutes.`}>{m.freshness.tag}</p>
        </>}
      />
      <FreshBanner freshness={m.freshness} />

      <div className="cl-top">
        <div className="tabs scroll" id="ledger" role="group" aria-label={`Who closed the tickets in week ${wk}`}>
          {CELLS.map(c => (
            <button key={c.by} type="button" data-by={c.by} aria-pressed={f.by === c.by}
              aria-label={`${m.counts[c.by === "all" ? "all" : c.by]} ${c.aria}${c.by === "all" ? "" : `. ${f.by === c.by ? "Show all" : "Show only these"}`}`}
              onClick={() => change({ by: f.by === c.by ? "all" : c.by })}>
              {c.label}<span className="n">{m.counts[c.by === "all" ? "all" : c.by]}</span>
            </button>
          ))}
        </div>
        <div className="cl-tools" id="tools">
          <div className="field cl-search"><label className="vh" htmlFor="q">Search tickets</label><input id="q" type="search" placeholder="Search number, question or category" autoComplete="off" value={f.q} onChange={e => change({ q: e.target.value.trim() })} /></div>
          <Modal label={<>Filters{active ? <span className="n">{active}</span> : null}</>} title="Filters" triggerClass="btn cl-fbtn"
            footer={<>
              <button type="button" className="btn" onClick={() => setD({ who: "", outcome: "" })}>Reset</button>
              <button type="button" className="btn pri" onClick={e => { change({ who: d.who, outcome: d.outcome }); e.currentTarget.closest("dialog")?.close(); }}>Apply</button>
            </>}>
            <div className="cl-filters" ref={box}>
              <div className="field cl-week"><span className="label" id="lbl-week">Week</span>
                <div className="cl-picker" role="group" aria-labelledby="lbl-week">
                  {m.week.prev ? <Link className="btn sm" href={weekHref(m.week.prev.key)} aria-label={`${m.week.prev.label}, previous week`}>‹ {m.week.prev.label}</Link> : null}
                  <span className="cl-cur" aria-current="date">{m.week.label}{m.week.partial ? " so far" : ""}<small>{m.week.span}</small></span>
                  {m.week.next ? <Link className="btn sm" href={weekHref(m.week.next.key)} aria-label={`${m.week.next.label}, next week`}>{m.week.next.label} ›</Link> : null}
                </div>
              </div>
              <div className="field"><label htmlFor="who">Person</label>
                <select id="who" value={d.who} onChange={e => setD(x => ({ ...x, who: e.target.value }))}>
                  <option value="">Anyone</option>
                  {m.people.map(p => <option key={p.id} value={p.id}>{p.person.label}</option>)}
                </select>
              </div>
              <div className="field"><label htmlFor="how">Outcome</label>
                <select id="how" value={d.outcome} onChange={e => setD(x => ({ ...x, outcome: e.target.value as Filters["outcome"] }))}>
                  <option value="">Resolved and not</option><option value="res">Resolved</option><option value="no">Closed without resolution</option>
                </select>
              </div>
              <div className="field"><span className="label" id="lbl-coh">Imported tickets</span>
                <ImportToggle on={imported} label="Include imported" week={m.week.key} base="/closed" />
              </div>
            </div>
          </Modal>
        </div>
      </div>

      <div className="cl-result">
        {f.who ? <button type="button" className="chip cl-chip" onClick={() => change({ who: "" })} aria-label={`Remove filter: person ${personLabel(f.who)}`}>Person: {personLabel(f.who)} <span aria-hidden="true">×</span></button> : null}
        {f.outcome ? <button type="button" className="chip cl-chip" onClick={() => change({ outcome: "" })} aria-label={`Remove filter: ${OUTCOME[f.outcome]}`}>{OUTCOME[f.outcome]} <span aria-hidden="true">×</span></button> : null}
        {imported ? <span className="chip quiet">Imported included</span> : null}
        <p className="result" id="result" aria-live="polite">{rows.length} of {m.total} closed tickets · week {wk}, UTC</p>
        <button className="txt-link" type="button" id="clearBtn" hidden={!any} onClick={() => { setF({ by: "all", who: "", outcome: "", q: "" }); setShown(STEP); }}>Show all {m.total}</button>
      </div>

      <div className="tbl-wrap cl-wrap">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Closed tickets table">
          <table className="tbl stack cl-tbl" id="tbl">
            <thead><tr><th scope="col">Ticket</th><th scope="col">Question</th><th scope="col">Category</th><th scope="col">Closed by</th><th scope="col">Closed</th><th scope="col" className="n">Took</th></tr></thead>
            <tbody id="rows">
              {rows.length ? rows.slice(0, shown).map(r => (
                <tr key={r.id}>
                  <th scope="row"><a href={r.href}>#{r.id}</a></th>
                  <td className={"q" + (r.question == null ? " hid" : "")} data-l="Question">{r.question ?? <><span className="chip dash">Withheld</span> {r.questionNote}</>}</td>
                  <td data-l="Category">{r.categoryLabel}</td>
                  <td data-l="Closed by"><ClosedByCell r={r} /></td>
                  <td data-l="Closed"><time dateTime={r.closedAt}>{r.closedText} UTC</time></td>
                  <td className="n" data-l="Took">{r.took.kind === "time" ? r.took.text : <span className="chip dash">{r.took.kind === "no_answer" ? "no answer" : "no resolution"}</span>}</td>
                </tr>
              )) : <tr><td colSpan={6} className="empty-note">{m.total ? "No closed tickets match. Clear a filter to see more." : m.empty ?? `Nothing finished in week ${wk}.`}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="cl-pager">
          <p id="pageNote">Showing {Math.min(shown, rows.length)} of {rows.length}, newest first.</p>
          <button className="btn sm" type="button" id="more" hidden={shown >= rows.length} onClick={() => setShown(n => n + STEP)}>Show {Math.min(STEP, Math.max(0, rows.length - shown))} more</button>
        </div>
      </div>
    </>
  );
}
